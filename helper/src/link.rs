// The link: the process that the plugin's monitor starts in a session (`erga link`). It holds a WebSocket to Erga
// (GET /api/agent/link, with the helper's token), hears the session's hooks on a socket of its own (hook.rs), and
// prints each message from the panel on stdout: Claude Code gives a monitor's line to Claude as a prompt. map.rs
// decides what each event becomes. A line that starts with "[Erga]" is the helper's own word to the person.
//
// The first time, the person approves the helper in their browser (auth.rs). When that fails, the link waits: the
// person types /erga:attach again, and the session's hook for that prompt starts the sign-in again.
//
// Codex has no monitor: a hook starts the link for its session (hook.rs: the prompt "erga attach"), apart from Codex.
// There the link prints nothing. A message from the panel goes in with `codex queue`, and a stop is `turn/interrupt`
// on the socket of Codex's own local server. Both are Codex's interfaces, and Codex marks that server experimental.

use crate::map::State;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

enum Msg {
    /// A hook's event, and where its answer goes.
    Hook(Value, Sender<String>),
    /// A frame from the panel.
    Down(String),
    /// The helper's own word to the person.
    Status(String),
}

trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

/// A model's id as people say it: "claude-opus-5-5" is "Opus 5.5".
fn model_name(id: &str) -> String {
    let parts: Vec<&str> = id.trim().trim_start_matches("claude-").split('-').filter(|p| p.len() < 8).collect();
    let (words, numbers): (Vec<&str>, Vec<&str>) = parts.iter().partition(|p| p.parse::<u32>().is_err());
    let words: Vec<String> = words.iter().map(|w| format!("{}{}", w[..1].to_uppercase(), &w[1..])).collect();
    format!("{} {}", words.join(" "), numbers.join(".")).trim().to_string()
}

/// The session that the link is for.
pub struct Session {
    pub id: String,
    /// Codex's, not Claude Code's.
    pub codex: bool,
    /// The model's id, when the one who started the link knows it (else the session's start left a note of it).
    pub model: Option<String>,
}

/// Gives Codex a message for its session: Codex starts a turn with it, or keeps it for the end of the turn that runs.
fn queue(sid: &str, text: &str) -> Result<(), String> {
    let out = std::process::Command::new("codex").args(["queue", "--thread", sid, "--message", text]).output().map_err(|e| format!("codex: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("codex queue failed").to_string())
}

/// Stops the turn `turn` of Codex's session at once: `turn/interrupt` on the socket of Codex's local server.
fn interrupt(sid: &str, turn: &str) -> Result<(), String> {
    let home = std::env::var("CODEX_HOME").unwrap_or_else(|_| format!("{}/.codex", std::env::var("HOME").unwrap_or_default()));
    let stream = UnixStream::connect(format!("{home}/app-server-control/app-server-control.sock")).map_err(|e| format!("Codex's local server: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = "ws://localhost/".into_client_request().map_err(|e| e.to_string())?;
    let (mut ws, _) = tungstenite::client::client(request, stream).map_err(|e| e.to_string())?;
    // One request, and the answer that has its id (the server's own notices come between).
    let mut call = |id: u64, method: &str, params: Value| -> Result<(), String> {
        ws.send(Message::text(json!({ "method": method, "id": id, "params": params }).to_string())).map_err(|e| e.to_string())?;
        if id == 0 {
            ws.send(Message::text(json!({ "method": "initialized" }).to_string())).map_err(|e| e.to_string())?;
        }
        loop {
            let Message::Text(text) = ws.read().map_err(|e| e.to_string())? else { continue };
            let v: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
            if v["id"] == id {
                return match v.get("error") {
                    Some(e) => Err(e["message"].as_str().unwrap_or("refused").to_string()),
                    None => Ok(()),
                };
            }
        }
    };
    let client = json!({ "name": "erga", "title": "Erga helper", "version": env!("CARGO_PKG_VERSION") });
    call(0, "initialize", json!({ "clientInfo": client, "capabilities": { "experimentalApi": false } }))?;
    call(1, "turn/interrupt", json!({ "threadId": sid, "turnId": turn }))
}

/// The session's hello: who it is, where it runs, and its model.
fn hello(session: &Session) -> String {
    let sid = &session.id;
    let host = std::process::Command::new("hostname").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    let cwd = if !home.is_empty() && cwd.starts_with(&home) { cwd.replacen(&home, "~", 1) } else { cwd };
    let model = session.model.clone().or_else(|| std::fs::read_to_string(crate::session_file(sid, "model")).ok()).map(|m| model_name(&m)).unwrap_or_default();
    let agent = if session.codex { "Codex" } else { "Claude Code" };
    let who = json!({ "session": sid, "agent": agent, "where": format!("{}, {}", host.trim_end_matches(".local"), cwd), "model": model });
    json!({ "type": "CUSTOM", "name": "hello", "value": who }).to_string()
}

fn connect(server: &str, ask: bool) -> Result<(WebSocket<Box<dyn Stream>>, TcpStream), String> {
    let token = crate::auth::token(server, ask)?;
    let (tls, rest) = match server.strip_prefix("https://") {
        Some(rest) => (true, rest),
        None => (false, server.strip_prefix("http://").ok_or("the server's address must start with https://")?),
    };
    let host = rest.split('/').next().unwrap_or("");
    let (name, port) = match host.rsplit_once(':') {
        Some((n, p)) => (n, p.parse::<u16>().map_err(|_| "a bad port")?),
        None => (host, if tls { 443 } else { 80 }),
    };
    let tcp = TcpStream::connect((name, port)).map_err(|e| format!("{host}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(20)));
    let copy = tcp.try_clone().map_err(|e| e.to_string())?;
    let stream: Box<dyn Stream> = if tls {
        let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let server_name = rustls::pki_types::ServerName::try_from(name.to_string()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(Arc::new(config), server_name).map_err(|e| e.to_string())?;
        Box::new(rustls::StreamOwned::new(conn, tcp))
    } else {
        Box::new(tcp)
    };
    let url = format!("{}/api/agent/link", server.replacen("http", "ws", 1));
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().map_err(|_| "a bad token")?);
    match tungstenite::client::client(request, stream) {
        Ok((ws, _)) => Ok((ws, copy)),
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(res))) => {
            // The server refused the token (a revoked grant, an old token): the next try makes a new one.
            if res.status() == 401 {
                crate::auth::refused(server);
            }
            Err(format!("the server answered {}", res.status()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Holds the WebSocket: frames up from `out`, frames down to `tx`. It comes back with why the socket ended.
fn pump(ws: &mut WebSocket<Box<dyn Stream>>, out: &Receiver<String>, tx: &Sender<Msg>) -> String {
    let mut pinged = Instant::now();
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let _ = tx.send(Msg::Down(text.to_string()));
            }
            Ok(Message::Close(_)) => return "the server closed the link".to_string(),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return e.to_string(),
        }
        while let Ok(frame) = out.try_recv() {
            if let Err(e) = ws.send(Message::text(frame)) {
                return e.to_string();
            }
        }
        if pinged.elapsed() > Duration::from_secs(25) {
            pinged = Instant::now();
            if let Err(e) = ws.send(Message::Ping(Vec::new().into())) {
                return e.to_string();
            }
        }
    }
}

/// The link's life: connect, say hello, hold the socket; when it ends, again a little later. `ask`: the person asked
/// to attach, so a sign-in in their browser is right (the start, and each /erga:attach).
fn hold(server: String, session: Session, out: Receiver<String>, tx: Sender<Msg>, ask: Arc<AtomicBool>) {
    let (mut wait, mut attached) = (1, false);
    loop {
        let asked = ask.swap(false, Ordering::SeqCst);
        let new = !crate::auth::signed_in(&server);
        match connect(&server, asked) {
            Ok((mut ws, tcp)) => {
                let _ = tcp.set_read_timeout(Some(Duration::from_millis(50)));
                if ws.send(Message::text(hello(&session))).is_ok() {
                    if !attached {
                        let host = server.split("://").nth(1).unwrap_or(&server);
                        // After a new sign-in, Claude Code must connect Erga's MCP server again: it asked for the header before.
                        let tools = if new { " Erga's tools connect when your person types /mcp reconnect all, one time." } else { "" };
                        let _ = tx.send(Msg::Status(format!("This session is attached: the agent panel on {host} shows it.{tools}")));
                    }
                    (attached, wait) = (true, 1);
                    let why = pump(&mut ws, &out, &tx);
                    eprintln!("erga: the link ended: {why}");
                }
            }
            Err(why) => {
                if asked || attached {
                    let _ = tx.send(Msg::Status(format!("This session is not attached to Erga: {why}. To try again, type /erga:attach.")));
                }
                attached = false;
            }
        }
        // Again after a pause that grows; at once when the person asks to attach.
        let until = Instant::now() + Duration::from_secs(wait);
        while Instant::now() < until && !ask.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
        wait = (wait * 2).min(30);
    }
}

/// One hook's connection: its event goes to the main loop, and the answer comes back as one line.
fn hear(stream: UnixStream, tx: Sender<Msg>) {
    let mut line = String::new();
    let mut reader = BufReader::new(stream);
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(&line) else { return };
    let (reply, answer) = channel();
    if tx.send(Msg::Hook(v, reply)).is_ok() {
        let _ = writeln!(reader.get_mut(), "{}", answer.recv().unwrap_or_else(|_| "{}".to_string()));
    }
}

/// Removes what sessions that ended without a word left in the helper's folder: files older than a week.
fn sweep() {
    let Ok(entries) = std::fs::read_dir(crate::run_dir()) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(7 * 24 * 3600));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A Codex link with no word from its session for this long ends: the session went without its end's hook.
const QUIET: Duration = Duration::from_secs(12 * 3600);

/// `codex`: the session that a Codex hook named. None: Claude Code's own session, whose monitor this process is.
pub fn run(server: &str, codex: Option<Session>) {
    let session = match codex {
        Some(s) => s,
        None => match std::env::var("CLAUDE_CODE_SESSION_ID") {
            Ok(id) => Session { id, codex: false, model: None },
            Err(_) => return println!("[Erga] This session is not attached to Erga: the helper found no session (it runs as the plugin's monitor)."),
        },
    };
    let (sid, codex) = (session.id.clone(), session.codex);
    sweep();
    let path = crate::session_file(&sid, "sock");
    // One link for a session: a second one leaves the first alone.
    if UnixStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return println!("[Erga] This session is not attached to Erga: {e}."),
    };
    let (tx, rx) = channel::<Msg>();
    let (up, out) = channel::<String>();
    let ask = Arc::new(AtomicBool::new(true));
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let tx = tx.clone();
                std::thread::spawn(move || hear(stream, tx));
            }
        });
    }
    {
        let (server, tx, ask) = (server.to_string(), tx.clone(), ask.clone());
        std::thread::spawn(move || hold(server, session, out, tx, ask));
    }

    let stamp = format!("{:x}", crate::auth::now());
    let mut state = State::new(&sid, &stamp, crate::read_only());
    state.codex = codex;
    let mut waits: Option<Sender<String>> = None;
    let say = |line: &str| {
        println!("{line}");
        let _ = std::io::stdout().flush();
    };
    // (Codex's link waits for each word at most QUIET; Claude Code ends its monitor itself.)
    while let Ok(msg) = if codex { rx.recv_timeout(QUIET).map_err(|_| ()) } else { rx.recv().map_err(|_| ()) } {
        match msg {
            // Codex has no monitor to print for: the note goes to the link's own log.
            Msg::Status(line) if codex => eprintln!("erga: {line}"),
            Msg::Status(line) => say(&format!("[Erga] {line} (Say this to your person in one short line. Do nothing else.)")),
            Msg::Down(text) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(why) = v["error"].as_str() {
                    eprintln!("erga: the server says: {why}");
                    continue;
                }
                let down = state.down(&v);
                for f in down.frames {
                    let _ = up.send(f.to_string());
                }
                if let (Some(answer), Some(hook)) = (down.answer, waits.take()) {
                    let _ = hook.send(answer.to_string());
                }
                if let Some(turn) = down.interrupt {
                    let sid = sid.clone();
                    std::thread::spawn(move || {
                        if let Err(why) = interrupt(&sid, &turn) {
                            eprintln!("erga: turn/interrupt: {why}");
                        }
                    });
                }
                match down.print {
                    Some(text) if codex => {
                        if let Err(why) = queue(&sid, &text) {
                            let _ = up.send(json!({ "type": "RUN_ERROR", "message": format!("Codex did not take the message: {why}") }).to_string());
                        }
                    }
                    Some(text) => say(&text),
                    None => {}
                }
            }
            Msg::Hook(v, reply) => {
                // The person asks to attach again (the monitor runs already): the link tries now, with a sign-in.
                let attach = |p: &str| p.trim_start().starts_with("/erga:attach") || crate::hook::is_attach(p);
                if v["hook_event_name"] == "UserPromptSubmit" && v["prompt"].as_str().is_some_and(attach) {
                    ask.store(true, Ordering::SeqCst);
                    let _ = reply.send("{}".to_string());
                    continue;
                }
                let got = state.hook(&v);
                for f in got.frames {
                    let _ = up.send(f.to_string());
                }
                if got.release {
                    if let Some(hook) = waits.take() {
                        let _ = hook.send("{}".to_string());
                    }
                }
                if got.wait {
                    waits = Some(reply);
                } else {
                    let _ = reply.send(got.reply.map(|r| r.to_string()).unwrap_or_else(|| "{}".to_string()));
                }
                if got.end {
                    // The frames go up before the process ends.
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = std::fs::remove_file(&path);
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_models_id_as_people_say_it() {
        assert_eq!(model_name("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(model_name("claude-fable-5-2\n"), "Fable 5.2");
        assert_eq!(model_name("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(model_name("gpt-6"), "Gpt 6");
    }
}
