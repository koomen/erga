// One hook event of the session: Claude Code gives its input on stdin, and this gives it to the session's link (a
// socket in the person's own folder). The link answers one line: what the hook prints. With no link, the session is
// not attached, and the hook ends at once. A permission prompt waits for the link's answer; every other hook waits 3
// seconds at most, so the helper never slows the session.
//
// Codex has no monitor to start the link: there the person types "erga attach" in a session, and the hook for that
// prompt starts the link for the session (its hooks name the server: `erga hook --server <url>`), then keeps the
// prompt from the model.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// The prompt that attaches a Codex session.
pub fn is_attach(prompt: &str) -> bool {
    prompt.trim().eq_ignore_ascii_case("erga attach")
}

/// Starts the link for a Codex session, apart from Codex (its own process group), with its notes in a log.
fn start_link(server: &str, sid: &str, model: &str) -> bool {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let Ok(exe) = std::env::current_exe() else { return false };
    let log = std::fs::File::create(crate::session_file(sid, "log")).map(Stdio::from).unwrap_or_else(|_| Stdio::null());
    Command::new(exe)
        .args(["link", "--server", server, "--agent", "codex", "--session", sid, "--model", model])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .process_group(0)
        .spawn()
        .is_ok()
}

/// `server`: the hooks of Codex name it (Claude Code's plugin starts the link with its monitor, and names none here).
pub fn run(server: Option<&str>) {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(&input) else { return };
    let (sid, event) = (v["session_id"].as_str().unwrap_or(""), v["hook_event_name"].as_str().unwrap_or(""));
    if sid.is_empty() {
        return;
    }
    // The session's model, for the link's hello: only the session's start names it.
    if let (true, Some(model)) = (event == "SessionStart", v["model"].as_str()) {
        let _ = std::fs::write(crate::session_file(sid, "model"), model);
    }
    // The session's end: its model's note goes (the link removes its own socket).
    if event == "SessionEnd" {
        let _ = std::fs::remove_file(crate::session_file(sid, "model"));
    }
    let attach = event == "UserPromptSubmit" && v["prompt"].as_str().is_some_and(is_attach);
    let Ok(mut stream) = UnixStream::connect(crate::session_file(sid, "sock")) else {
        // Codex: "erga attach" starts the link. The prompt stops here: it is for the helper, not for the model.
        if let (true, Some(server)) = (attach, server) {
            let said = if start_link(server, sid, v["model"].as_str().unwrap_or("")) {
                "Attaching this session to Erga. Approve it in your browser if Erga asks; then your agent panel shows this session."
            } else {
                "Erga's helper could not start the link for this session."
            };
            println!("{}", serde_json::json!({ "decision": "block", "reason": said }));
        }
        return;
    };
    let _ = stream.set_read_timeout(if event == "PermissionRequest" { None } else { Some(Duration::from_secs(3)) });
    if writeln!(stream, "{v}").is_err() {
        return;
    }
    let mut reply = String::new();
    let _ = BufReader::new(stream).read_line(&mut reply);
    let reply = reply.trim();
    if attach && server.is_some() {
        // Attached already: the link tries its connection again, and the prompt stops here too.
        println!("{}", serde_json::json!({ "decision": "block", "reason": "This session is attached to Erga: your agent panel shows it." }));
    } else if !reply.is_empty() && reply != "{}" {
        println!("{reply}");
    }
}
