// Erga's helper: one small program beside an agent's session (Claude Code), which Erga's plugin runs. It attaches the
// session to its person's agent panel in Erga: the session's hooks go up as AG-UI events, and the panel's messages
// come down (map.rs has the map). It keeps the sign-in (auth.rs), so the model never sees a token.
//
//   erga link --server <url>     the plugin's monitor: holds the link, and prints each message from the panel
//   erga hook                    each hook of the session: gives the event to the link; not attached: it ends at once
//   erga header --server <url>   the header for Erga's MCP server (Claude Code's headersHelper), as JSON
//   erga codex --server <url>    adds the helper's hooks to Codex (--remove takes them out); then "erga attach" in Codex
//   erga read-only on|off        the panel may watch this computer's sessions, not operate them
//   erga sign-out --server <url> forgets the sign-in

mod auth;
mod hook;
mod link;
mod map;

use std::path::PathBuf;

/// Where a session's link listens for its hooks, and what the hooks keep for it: a folder that only the person reads.
pub fn run_dir() -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("{}/.cache", std::env::var("HOME").unwrap_or_default()));
    let dir = PathBuf::from(base).join("erga-helper");
    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir);
    dir
}

/// A session's files there: its id's first 16 letters and digits (a socket's path is short).
pub fn session_file(sid: &str, kind: &str) -> PathBuf {
    let short: String = sid.chars().filter(char::is_ascii_alphanumeric).take(16).collect();
    run_dir().join(format!("{short}.{kind}"))
}

fn config_file(name: &str) -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
    PathBuf::from(base).join("erga").join(name)
}

/// Whether the panel may only watch this computer's sessions.
pub fn read_only() -> bool {
    config_file("read-only").exists()
}

/// Codex's events that the helper hears, and how long Codex lets each hook run (seconds).
const CODEX_HOOKS: [(&str, u64); 7] =
    [("UserPromptSubmit", 10), ("PreToolUse", 10), ("PostToolUse", 10), ("PermissionRequest", 600), ("Stop", 10), ("SessionEnd", 3), ("Interrupt", 3)];

/// Adds the helper's hooks for `server` to Codex's own hooks file, or takes them out. The person's other hooks stay.
fn codex_hooks(server: &str, remove: bool) {
    let home = std::env::var("CODEX_HOME").unwrap_or_else(|_| format!("{}/.codex", std::env::var("HOME").unwrap_or_default()));
    let file = PathBuf::from(&home).join("hooks.json");
    let mut all: serde_json::Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "erga".to_string());
    let command = format!("\"{exe}\" hook --server {server}");
    let ours = |entry: &serde_json::Value| {
        entry["hooks"].as_array().is_some_and(|h| h.iter().any(|h| h["command"].as_str().is_some_and(|c| c.ends_with(&format!(" hook --server {server}")))))
    };
    if !all["hooks"].is_object() {
        all["hooks"] = serde_json::json!({});
    }
    for (event, timeout) in CODEX_HOOKS {
        let mut list: Vec<serde_json::Value> = all["hooks"][event].as_array().cloned().unwrap_or_default();
        list.retain(|e| !ours(e));
        if !remove {
            list.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
        }
        if list.is_empty() {
            all["hooks"].as_object_mut().unwrap().remove(event);
        } else {
            all["hooks"][event] = serde_json::Value::Array(list);
        }
    }
    let _ = std::fs::create_dir_all(&home);
    match std::fs::write(&file, format!("{}\n", serde_json::to_string_pretty(&all).unwrap_or_default())) {
        Err(e) => eprintln!("erga: {}: {e}", file.display()),
        Ok(()) if remove => println!("Erga's hooks are out of {}.", file.display()),
        Ok(()) => println!("Erga's hooks are in {}.\nIn Codex: approve them one time (/hooks). Then, in a session, type: erga attach", file.display()),
    }
}

const USAGE: &str = "erga: Erga's helper for an agent's session.
  erga link --server <url>      attach this session to your agent panel (the plugin's monitor runs it)
  erga hook                     give one hook event of the session to its link (the plugin's hooks run it)
  erga header --server <url>    print the header for Erga's MCP server
  erga codex --server <url>     add the helper's hooks to Codex (--remove: take them out); then type: erga attach
  erga read-only on|off         the panel may watch this computer's sessions, not operate them
  erga sign-out --server <url>  forget the sign-in";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let server = args.iter().position(|a| a == "--server").and_then(|i| args.get(i + 1)).map(|s| s.trim_end_matches('/').to_string());
    let need = || {
        server.clone().unwrap_or_else(|| {
            eprintln!("erga: name the server: --server https://…");
            std::process::exit(2)
        })
    };
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    match args.first().map(String::as_str) {
        Some("link") => {
            let codex = flag("--agent").as_deref() == Some("codex");
            let session = flag("--session").filter(|_| codex).map(|id| link::Session { id, codex: true, model: flag("--model").filter(|m| !m.is_empty()) });
            link::run(&need(), session)
        }
        Some("hook") => hook::run(server.as_deref()),
        Some("codex") => codex_hooks(&need(), args.iter().any(|a| a == "--remove")),
        Some("header") => match auth::token(&need(), false) {
            Ok(token) => println!("{}", serde_json::json!({ "Authorization": format!("Bearer {token}") })),
            // Not signed in yet. The header is there all the same: Claude Code then takes the server as one whose
            // header this helper gives, and asks again when its connection is refused (after /erga:attach it works).
            Err(_) => println!("{}", serde_json::json!({ "Authorization": "Bearer not-signed-in" })),
        },
        Some("read-only") => {
            let file = config_file("read-only");
            if args.get(1).map(String::as_str) == Some("on") {
                let _ = std::fs::create_dir_all(file.parent().unwrap());
                let _ = std::fs::write(&file, "");
            } else {
                let _ = std::fs::remove_file(&file);
            }
            println!("read-only: {}", if read_only() { "on" } else { "off" });
        }
        Some("sign-out") => auth::sign_out(&need()),
        _ => println!("{USAGE}"),
    }
}
