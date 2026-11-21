// The helper's sign-in at Erga's gate, as any MCP app signs in: OAuth with PKCE, a redirect to this computer, and a
// client that registers itself. The person approves in their browser, one time: Erga makes one grant row. The helper
// keeps the refresh grant and the last token in the system's keychain (macOS), or in a file that only the person
// reads (Linux): the model never sees them. `erga header` gives Claude Code the same token for Erga's MCP server, so
// one sign-in is sufficient.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long the person has to approve.
const APPROVE: Duration = Duration::from_secs(300);
/// A token with less time left than this is made again.
const SPARE: u64 = 120;

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the system gives random bytes");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(20))).build().into()
}

fn json_of(mut res: ureq::http::Response<ureq::Body>, what: &str) -> Result<Value, String> {
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{what}: {e}"))?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status >= 300 {
        let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("").to_string();
        return Err(format!("{what}: the server answered {status} {why}").trim().to_string());
    }
    Ok(v)
}

fn get(url: &str) -> Result<Value, String> {
    json_of(agent().get(url).header("Accept", "application/json").call().map_err(|e| format!("{url}: {e}"))?, url)
}

fn form(url: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    json_of(agent().post(url).send_form(fields.iter().cloned()).map_err(|e| format!("{url}: {e}"))?, url)
}

/// The gate's endpoints, as its metadata names them.
struct Endpoints {
    authorize: String,
    token: String,
    register: String,
}

fn endpoints(server: &str) -> Result<Endpoints, String> {
    let resource = get(&format!("{server}/.well-known/oauth-protected-resource")).unwrap_or(Value::Null);
    let issuer = resource["authorization_servers"][0].as_str().unwrap_or(server).trim_end_matches('/').to_string();
    let meta = get(&format!("{issuer}/.well-known/oauth-authorization-server"))?;
    let at = |k: &str| meta[k].as_str().map(str::to_string).ok_or(format!("the server's sign-in metadata has no {k}"));
    Ok(Endpoints { authorize: at("authorization_endpoint")?, token: at("token_endpoint")?, register: at("registration_endpoint")? })
}

/// The token for `server`: the kept one, a new one from the refresh grant, or (with `ask`) a new sign-in.
pub fn token(server: &str, ask: bool) -> Result<String, String> {
    if let Some(kept) = store::get(server) {
        if kept["expires"].as_u64().unwrap_or(0) > now() + SPARE {
            if let Some(t) = kept["token"].as_str() {
                return Ok(t.to_string());
            }
        }
        if let Ok(t) = refresh(server, &kept) {
            return Ok(t);
        }
    }
    if !ask {
        return Err("not signed in".to_string());
    }
    sign_in(server)
}

/// Whether the helper has a sign-in at `server` (a grant that may have ended since).
pub fn signed_in(server: &str) -> bool {
    store::get(server).is_some()
}

/// A token that the server refused (401): the kept one is forgotten, so the next `token` makes one.
pub fn refused(server: &str) {
    if let Some(mut kept) = store::get(server) {
        kept["expires"] = json!(0);
        store::set(server, &kept);
    }
}

fn keep(server: &str, client: &str, answer: &Value, refresh: Option<&str>) -> Result<String, String> {
    let token = answer["access_token"].as_str().ok_or("the server gave no token")?.to_string();
    let refresh = answer["refresh_token"].as_str().or(refresh).unwrap_or("");
    let expires = now() + answer["expires_in"].as_u64().unwrap_or(3600);
    store::set(server, &json!({ "client": client, "token": token, "refresh": refresh, "expires": expires }));
    Ok(token)
}

fn refresh(server: &str, kept: &Value) -> Result<String, String> {
    let (client, grant) = (kept["client"].as_str().unwrap_or(""), kept["refresh"].as_str().unwrap_or(""));
    if grant.is_empty() {
        return Err("no refresh grant".to_string());
    }
    let answer = form(&endpoints(server)?.token, &[("grant_type", "refresh_token"), ("refresh_token", grant), ("client_id", client)])?;
    keep(server, client, &answer, Some(grant))
}

/// The sign-in: the person's browser opens the gate's approve page, and comes back to this computer with a code.
fn sign_in(server: &str) -> Result<String, String> {
    let ends = endpoints(server)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no port on this computer: {e}"))?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());
    let registration = json!({ "client_name": "Claude Code", "redirect_uris": [redirect], "token_endpoint_auth_method": "none" });
    let registered = json_of(
        agent().post(&ends.register).header("Content-Type", "application/json").send(registration.to_string()).map_err(|e| e.to_string())?,
        "the registration",
    )?;
    let client = registered["client_id"].as_str().ok_or("the server gave no client id")?.to_string();
    let (verifier, state) = (random(48), random(16));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let resource = format!("{server}/mcp");
    let query: Vec<String> = [
        ("response_type", "code"),
        ("client_id", client.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("resource", resource.as_str()),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={}", encode(v)))
    .collect();
    let url = format!("{}?{}", ends.authorize, query.join("&"));
    eprintln!("erga: approve this session in your browser: {url}");
    open(&url);
    let code = callback(&listener, &state)?;
    let answer = form(
        &ends.token,
        &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client), ("redirect_uri", &redirect), ("code_verifier", &verifier)],
    )?;
    keep(server, &client, &answer, None)
}

/// Percent-encodes a query value.
fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn decode(s: &str) -> String {
    let (bytes, mut out, mut i) = (s.as_bytes(), Vec::new(), 0);
    while i < bytes.len() {
        let hex = if bytes[i] == b'%' { s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) } else { None };
        match hex {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Opens the person's browser at `url`: the program that BROWSER names, else the system's own way.
fn open(url: &str) {
    let program = std::env::var("BROWSER").unwrap_or_else(|_| if cfg!(target_os = "macos") { "open" } else { "xdg-open" }.to_string());
    let _ = std::process::Command::new(program).arg(url).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

/// Waits for the browser at the redirect: the code, when the state is the one that this sign-in made.
fn callback(listener: &TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let until = Instant::now() + APPROVE;
    while Instant::now() < until {
        let Ok((mut stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let path = head.split_whitespace().nth(1).unwrap_or("");
        let query = path.strip_prefix("/callback?").unwrap_or("");
        let field = |name: &str| query.split('&').find_map(|p| p.strip_prefix(&format!("{name}=") as &str)).map(decode);
        let good = field("state").as_deref() == Some(state);
        let code = field("code").filter(|_| good);
        let page = if code.is_some() { "This session is attached to Erga. You can close this tab." } else { "Erga did not attach this session." };
        let body =
            format!("<!doctype html><meta charset=utf-8><title>Erga</title><body style=\"font:16px system-ui;margin:20vh auto;max-width:28rem\"><p>{page}</p>");
        let _ =
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        if let Some(code) = code {
            return Ok(code);
        }
        if good {
            return Err(format!("the sign-in was not approved ({})", field("error").unwrap_or_default()));
        }
    }
    Err("nobody approved the sign-in in 5 minutes".to_string())
}

/// Forgets the sign-in at `server`.
pub fn sign_out(server: &str) {
    store::remove(server);
}

/// Where the helper keeps a server's credentials, one JSON value for each server: the login keychain on macOS, else a
/// file in the person's config folder that only they read. ERGA_HELPER_STORE names a folder for the files instead
/// (a computer with no keychain, a test).
mod store {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::Value;
    use std::io::Write;
    use std::process::{Command, Stdio};

    const SERVICE: &str = "Erga helper";
    /// macOS's own tool for the keychain. An item that it made, it reads again with no question to the person: a
    /// helper that is not signed by one maker would get that question after each of its updates.
    const SECURITY: &str = "/usr/bin/security";

    fn folder() -> Option<String> {
        if let Ok(dir) = std::env::var("ERGA_HELPER_STORE") {
            return Some(dir);
        }
        if cfg!(target_os = "macos") {
            return None;
        }
        let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
        Some(format!("{base}/erga"))
    }
    fn path(dir: &str, server: &str) -> std::path::PathBuf {
        let name: String = server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect();
        std::path::Path::new(dir).join(format!("{name}.json"))
    }

    pub fn get(server: &str) -> Option<Value> {
        if let Some(dir) = folder() {
            return serde_json::from_slice(&std::fs::read(path(&dir, server)).ok()?).ok();
        }
        let out = Command::new(SECURITY).args(["find-generic-password", "-s", SERVICE, "-a", server, "-w"]).stderr(Stdio::null()).output().ok()?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(String::from_utf8_lossy(&out.stdout).trim()).ok()?).ok()
    }

    pub fn set(server: &str, v: &Value) {
        if let Some(dir) = folder() {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
            let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path(&dir, server)) {
                let _ = f.write_all(v.to_string().as_bytes());
            }
            return;
        }
        // The value goes to the tool on its input, never in its arguments (another program can read those).
        let secret = URL_SAFE_NO_PAD.encode(v.to_string());
        if let Ok(mut tool) = Command::new(SECURITY).arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            if let Some(mut input) = tool.stdin.take() {
                let _ = writeln!(input, "add-generic-password -U -s \"{SERVICE}\" -a \"{server}\" -w \"{secret}\"");
            }
            let _ = tool.wait();
        }
    }

    pub fn remove(server: &str) {
        match folder() {
            Some(dir) => drop(std::fs::remove_file(path(&dir, server))),
            None => {
                drop(Command::new(SECURITY).args(["delete-generic-password", "-s", SERVICE, "-a", server]).stdout(Stdio::null()).stderr(Stdio::null()).status())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_value_goes_and_comes_back() {
        assert_eq!(encode("http://127.0.0.1:5123/callback?a=b c"), "http%3A%2F%2F127.0.0.1%3A5123%2Fcallback%3Fa%3Db%20c");
        assert_eq!(decode("a%2Fb+c%3D%E2%9C%93"), "a/b c=✓");
        assert_eq!(decode("100%"), "100%");
    }
}
