// The map from a Claude Code session's hooks to AG-UI 1.0 events, and from the panel's frames to what the session
// gets. It has no IO: `link.rs` owns the sockets and does what this answers.
//
// Up (hooks to events, one frame each):
//   UserPromptSubmit     a prompt typed in the terminal: RUN_STARTED with its input. A prompt that came from the panel
//                        (Claude Code gives the monitor's line as a prompt): RUN_STARTED with the panel's run id.
//   MessageDisplay       TEXT_MESSAGE_CHUNK: Claude Code gives the text in parts of whole lines.
//   PreToolUse           TOOL_CALL_START, _ARGS, _END
//   PermissionRequest    RUN_FINISHED with the outcome interrupt. The hook waits: the panel's answer, or the
//                        terminal's (the next event of the session shows that the terminal answered).
//   PostToolUse          TOOL_CALL_RESULT
//   Stop                 RUN_FINISHED
// Down (frames to the session):
//   RunAgentInput        a message: one line for the monitor to print. With `resume`: the answer to the hook that waits.
//   {"cancel": runId}    the next tool hook answers `continue: false`. Claude Code stops at a tool, never in its text.
//
// Codex (`codex`): its hooks have the same names and fields, with these differences.
//   - No hook has the text as it comes: the turn's last message goes up at Stop.
//   - A message from the panel goes in with `codex queue`, and comes back as a plain prompt with the same text.
//   - Codex runs a permission hook before the terminal shows its prompt, so the terminal waits while the panel has
//     the card. Only a turn that the panel started gets a card; a turn from the terminal keeps its prompt there.
//   - A stop is also Codex's own `turn/interrupt` (link.rs calls it), at once; the Interrupt hook ends the run.

use serde_json::{json, Value};
use std::collections::VecDeque;

/// The plugin's monitor has this description: Claude Code names it in the prompt that carries a monitor's line.
pub const MONITOR: &str = "Messages from the Erga panel";
/// The longest text of one argument or result that goes up: the panel shows a line, not a file.
const MOST: usize = 2000;
const STOPPED: &str = "Stopped from the Erga panel";

/// A permission prompt that waits, in the terminal and in the panel.
struct Pending {
    interrupt: String,
    call: String,
    /// The run that stopped to ask.
    parent: String,
}

pub struct State {
    /// The session's id: the thread.
    sid: String,
    /// What makes this process's ids its own (its start time).
    stamp: String,
    n: u64,
    run: Option<String>,
    /// Messages from the panel that the monitor printed, and Claude Code has not given yet: the run's id, and its text.
    panel: VecDeque<(String, String)>,
    /// The last tool call that started: its name, its input and its id (a permission prompt names no call).
    last: Option<(String, Value, String)>,
    pending: Option<Pending>,
    stop: bool,
    /// The panel may watch, not operate.
    pub read_only: bool,
    /// The session is Codex's, not Claude Code's.
    pub codex: bool,
    /// Codex's id of the turn that runs (each hook names it): what `turn/interrupt` needs.
    turn: Option<String>,
    /// The run that is open came from the panel.
    from_panel: bool,
}

/// What a hook's event gives: frames for the link, and the hook's answer.
#[derive(Default)]
pub struct Up {
    pub frames: Vec<Value>,
    /// What the hook prints (JSON); none: nothing.
    pub reply: Option<Value>,
    /// The hook waits for an answer (a permission prompt).
    pub wait: bool,
    /// The hook that waited gets no answer: the terminal answered.
    pub release: bool,
    /// The session ended.
    pub end: bool,
}

/// What a frame from the panel gives.
#[derive(Default)]
pub struct Down {
    pub frames: Vec<Value>,
    /// A message for the session: the monitor prints it.
    pub print: Option<String>,
    /// The answer for the hook that waits.
    pub answer: Option<Value>,
    /// Codex: the turn to interrupt now.
    pub interrupt: Option<String>,
}

/// A value's text, cut to the most that goes up.
fn cut(text: &str) -> String {
    if text.len() <= MOST {
        return text.to_string();
    }
    let mut end = MOST;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// A tool's input with each long text cut.
fn short(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(cut(s)),
        Value::Array(a) => Value::Array(a.iter().take(50).map(short).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), short(v))).collect()),
        other => other.clone(),
    }
}

/// A tool's result as text: a shell's output, or the value as JSON.
fn result(v: &Value) -> String {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    let out = if v.get("stdout").is_some() {
        [text("stdout"), text("stderr")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n")
    } else if let Some(s) = v.as_str() {
        s.to_string()
    } else {
        v.to_string()
    };
    cut(&out)
}

impl State {
    pub fn new(sid: &str, stamp: &str, read_only: bool) -> State {
        State {
            sid: sid.to_string(),
            stamp: stamp.to_string(),
            n: 0,
            run: None,
            panel: VecDeque::new(),
            last: None,
            pending: None,
            stop: false,
            read_only,
            codex: false,
            turn: None,
            from_panel: false,
        }
    }

    fn id(&mut self, kind: &str) -> String {
        self.n += 1;
        format!("{}-{}-{}", kind, self.stamp, self.n)
    }

    /// A run starts: `input` is the prompt, when the terminal started it; `parent` is the run that it goes on from.
    fn start(&mut self, frames: &mut Vec<Value>, run: String, input: Option<&str>, parent: Option<&str>) {
        let mut ev = json!({ "type": "RUN_STARTED", "threadId": self.sid, "runId": run });
        if let Some(p) = parent {
            ev["parentRunId"] = json!(p);
        }
        if let Some(text) = input {
            let message = json!({ "id": self.id("u"), "role": "user", "content": text });
            ev["input"] = json!({ "threadId": self.sid, "runId": run, "messages": [message] });
        }
        frames.push(ev);
        self.run = Some(run);
    }

    fn finish(&mut self, frames: &mut Vec<Value>, outcome: Value) {
        if let Some(run) = self.run.take() {
            frames.push(json!({ "type": "RUN_FINISHED", "threadId": self.sid, "runId": run, "outcome": outcome }));
        }
    }

    /// The session works: a run is open (the session started it by itself, if no prompt did).
    fn working(&mut self, frames: &mut Vec<Value>) {
        if self.run.is_none() {
            let run = self.id("r");
            self.start(frames, run, None, None);
            self.from_panel = false;
        }
    }

    /// The session went on past a permission prompt: the terminal answered it. The run goes on.
    fn released(&mut self, up: &mut Up) {
        if let Some(p) = self.pending.take() {
            up.release = true;
            let run = self.id("r");
            self.start(&mut up.frames, run, None, Some(&p.parent));
        }
    }

    /// The answer of a tool hook: the turn stops there, when the panel asked for a stop.
    fn stopped(&mut self, up: &mut Up, before: Option<&str>) {
        if !self.stop || self.run.is_none() {
            return;
        }
        self.stop = false;
        let mut reply = json!({ "continue": false, "stopReason": STOPPED });
        // Before a tool: the tool must not run either.
        if let Some(call) = before {
            reply["hookSpecificOutput"] = json!({ "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": STOPPED });
            let message = self.id("m");
            up.frames.push(json!({ "type": "TOOL_CALL_RESULT", "messageId": message, "toolCallId": call, "content": STOPPED }));
        }
        up.reply = Some(reply);
        // Claude Code runs no Stop hook after such a stop: the run ends here.
        self.finish(&mut up.frames, json!({ "type": "cancelled" }));
    }

    /// One hook event of the session (the hook's input, as Claude Code gives it).
    pub fn hook(&mut self, v: &Value) -> Up {
        let mut up = Up::default();
        let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let call = text("tool_use_id");
        if let Some(turn) = v.get("turn_id").and_then(Value::as_str) {
            self.turn = Some(turn.to_string());
        }
        match text("hook_event_name").as_str() {
            "UserPromptSubmit" => {
                self.released(&mut up);
                let prompt = text("prompt");
                // Codex: a message that `codex queue` put in comes back as the prompt itself.
                let queued = if self.codex { self.panel.iter().position(|(_, t)| *t == prompt) } else { None };
                if let Some((run, _)) = queued.and_then(|i| self.panel.remove(i)) {
                    self.finish(&mut up.frames, json!({ "type": "success" }));
                    self.start(&mut up.frames, run, None, None);
                    self.from_panel = true;
                } else if !prompt.starts_with("<task-notification>") {
                    self.from_panel = false;
                    // Typed in the terminal. A turn that still runs takes it in: for the panel, the next run.
                    self.finish(&mut up.frames, json!({ "type": "success" }));
                    let run = self.id("r");
                    self.start(&mut up.frames, run, Some(&prompt), None);
                } else if self.run.is_none() {
                    // A line of the monitor's (a message from the panel), or another task that woke the session.
                    let mine = prompt.contains(MONITOR);
                    let sent: Vec<String> = self.panel.iter().filter(|(_, t)| mine && prompt.contains(t.as_str())).map(|(r, _)| r.clone()).collect();
                    self.panel.retain(|(r, _)| !sent.contains(r));
                    let run = sent.first().cloned().unwrap_or_else(|| self.id("r"));
                    self.start(&mut up.frames, run, None, None);
                } else {
                    // The session took the panel's message into the turn that runs.
                    self.panel.retain(|(_, t)| !prompt.contains(t.as_str()));
                }
            }
            "MessageDisplay" => {
                let delta = text("delta");
                if !delta.is_empty() {
                    // Claude Code runs a turn's last text hook and its Stop hook at one time: text that comes after
                    // the Stop is a short run of its own, so that the panel never waits for an end that came already.
                    let late = self.run.is_none();
                    self.working(&mut up.frames);
                    up.frames.push(json!({ "type": "TEXT_MESSAGE_CHUNK", "messageId": text("message_id"), "delta": delta }));
                    if late {
                        self.finish(&mut up.frames, json!({ "type": "success" }));
                    }
                }
            }
            "PreToolUse" => {
                self.working(&mut up.frames);
                let input = v.get("tool_input").cloned().unwrap_or(json!({}));
                self.call(&mut up.frames, &call, &text("tool_name"), &input);
                self.last = Some((text("tool_name"), input, call.clone()));
                self.stopped(&mut up, Some(&call));
            }
            "PermissionRequest" => {
                // One prompt at a time has a card; with the panel read-only, none has. Codex: only in a turn that the
                // panel started (its terminal shows no prompt while the hook waits).
                if self.pending.is_some() || self.read_only || (self.codex && !self.from_panel) {
                    return up;
                }
                let input = v.get("tool_input").cloned().unwrap_or(json!({}));
                let known = self.last.as_ref().filter(|(name, i, _)| *name == text("tool_name") && *i == input).map(|(_, _, id)| id.clone());
                self.working(&mut up.frames);
                let call = match known {
                    Some(id) => id,
                    None => {
                        let id = self.id("c");
                        self.call(&mut up.frames, &id, &text("tool_name"), &input);
                        id
                    }
                };
                let interrupt = self.id("i");
                let parent = self.run.clone().unwrap_or_default();
                let ask = json!({ "id": interrupt, "reason": "permission", "toolCallId": call });
                self.finish(&mut up.frames, json!({ "type": "interrupt", "interrupts": [ask] }));
                self.pending = Some(Pending { interrupt, call, parent });
                up.wait = true;
            }
            "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" => {
                if self.pending.as_ref().is_some_and(|p| p.call == call) {
                    self.released(&mut up);
                }
                self.working(&mut up.frames);
                let content = match v.get("tool_response") {
                    Some(r) => result(r),
                    None => cut(&[text("error"), text("reason")].concat()),
                };
                let message = self.id("m");
                up.frames.push(json!({ "type": "TOOL_CALL_RESULT", "messageId": message, "toolCallId": call, "content": content }));
                self.stopped(&mut up, None);
            }
            "Stop" | "StopFailure" => {
                self.released(&mut up);
                self.stop = false;
                // Codex has the turn's text only here.
                let said = text("last_assistant_message");
                if self.codex && !said.is_empty() {
                    self.working(&mut up.frames);
                    let message = self.id("m");
                    up.frames.push(json!({ "type": "TEXT_MESSAGE_CHUNK", "messageId": message, "delta": said }));
                }
                self.finish(&mut up.frames, json!({ "type": "success" }));
            }
            // Codex: the turn was interrupted (Esc in the terminal, or the panel's stop).
            "Interrupt" => {
                self.released(&mut up);
                self.stop = false;
                self.finish(&mut up.frames, json!({ "type": "cancelled" }));
            }
            "SessionEnd" => {
                self.released(&mut up);
                self.finish(&mut up.frames, json!({ "type": "success" }));
                up.end = true;
            }
            _ => {}
        }
        up
    }

    /// A tool call's three events.
    fn call(&mut self, frames: &mut Vec<Value>, id: &str, name: &str, input: &Value) {
        frames.push(json!({ "type": "TOOL_CALL_START", "toolCallId": id, "toolCallName": name }));
        frames.push(json!({ "type": "TOOL_CALL_ARGS", "toolCallId": id, "delta": short(input).to_string() }));
        frames.push(json!({ "type": "TOOL_CALL_END", "toolCallId": id }));
    }

    /// One frame from the panel.
    pub fn down(&mut self, v: &Value) -> Down {
        let mut down = Down::default();
        if v.get("cancel").is_some() {
            self.stop = self.run.is_some() && !self.read_only;
            // Codex stops at once, with its own interrupt; the next tool hook is the second way.
            if self.stop && self.codex {
                down.interrupt = self.turn.clone();
            }
            return down;
        }
        let Some(run) = v.get("runId").and_then(Value::as_str).map(str::to_string) else { return down };
        if self.read_only {
            let message = "This computer's helper is read-only: the panel can watch this session, not operate it.";
            down.frames.push(json!({ "type": "RUN_STARTED", "threadId": self.sid, "runId": run }));
            down.frames.push(json!({ "type": "RUN_ERROR", "message": message }));
            return down;
        }
        // The answer to the prompt that waits.
        let answer = v.get("resume").and_then(Value::as_array).and_then(|list| {
            let p = self.pending.as_ref()?;
            list.iter().find(|e| e["interruptId"] == p.interrupt.as_str() && e["status"] == "resolved").map(|e| e["payload"]["approved"] == true)
        });
        if let Some(approved) = answer {
            let p = self.pending.take().unwrap();
            let decision = if approved { json!({ "behavior": "allow" }) } else { json!({ "behavior": "deny", "message": "Denied in the Erga panel" }) };
            down.answer = Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }));
            self.start(&mut down.frames, run.clone(), None, Some(&p.parent));
        }
        // A message of the person's: the last user message, and what they have open.
        let message = v.get("messages").and_then(Value::as_array).and_then(|m| m.iter().rev().find(|m| m["role"] == "user"));
        if let Some(text) = message.and_then(|m| m["content"].as_str()).filter(|t| !t.trim().is_empty()) {
            let open = v["context"][0]["value"].as_str().unwrap_or("");
            let whole = if open.is_empty() { text.to_string() } else { format!("{}\n[In Erga: {}]", text, open.replace('\n', " ")) };
            // What the prompt is known by when it comes back: Claude Code wraps it (its first line is in there); Codex
            // gives it whole.
            let key = if self.codex { whole.clone() } else { text.trim().lines().next().unwrap_or("").to_string() };
            self.panel.push_back((run, key));
            down.print = Some(whole);
        }
        down
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(frames: &[Value]) -> Vec<String> {
        frames.iter().map(|f| f["type"].as_str().unwrap().to_string()).collect()
    }
    fn hook(event: &str, more: Value) -> Value {
        let mut v = json!({ "session_id": "s1", "hook_event_name": event });
        for (k, x) in more.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }
    fn state() -> State {
        State::new("s1", "t", false)
    }
    fn notification(line: &str) -> Value {
        let prompt = format!(
            "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: \"{}\"</summary>\n<event>{}</event>\n</task-notification>",
            MONITOR, line
        );
        hook("UserPromptSubmit", json!({ "prompt": prompt }))
    }

    #[test]
    fn a_prompt_in_the_terminal_is_a_run_with_its_input() {
        let mut s = state();
        let up = s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Use winter.jpg" })));
        assert_eq!(types(&up.frames), ["RUN_STARTED"]);
        assert_eq!(up.frames[0]["threadId"], "s1");
        assert_eq!(up.frames[0]["input"]["messages"][0]["content"], "Use winter.jpg");
        let text = s.hook(&hook("MessageDisplay", json!({ "message_id": "m1", "delta": "I'll do it.\n\n", "final": false })));
        assert_eq!(text.frames, [json!({ "type": "TEXT_MESSAGE_CHUNK", "messageId": "m1", "delta": "I'll do it.\n\n" })]);
        let end = s.hook(&hook("Stop", json!({ "last_assistant_message": "I'll do it." })));
        assert_eq!(end.frames[0]["outcome"]["type"], "success");
        assert_eq!(end.frames[0]["runId"], up.frames[0]["runId"]);
        // With no run open, a Stop says nothing.
        assert!(s.hook(&hook("Stop", json!({}))).frames.is_empty());
        // Text that comes after its turn's Stop is a whole short run: the panel is not left at work.
        let late = s.hook(&hook("MessageDisplay", json!({ "message_id": "m1", "delta": "Done.", "final": true })));
        assert_eq!(types(&late.frames), ["RUN_STARTED", "TEXT_MESSAGE_CHUNK", "RUN_FINISHED"]);
    }

    #[test]
    fn a_message_from_the_panel_is_printed_and_its_run_has_the_panels_id() {
        let mut s = state();
        let input = json!({ "threadId": "s1", "runId": "panel-1", "messages": [{ "id": "u", "role": "user", "content": "Add a map\nof our days" }],
            "context": [{ "description": "What the person has open in Erga", "value": "Open: Trip" }] });
        let down = s.down(&input);
        assert_eq!(down.print.as_deref(), Some("Add a map\nof our days\n[In Erga: Open: Trip]"));
        assert!(down.frames.is_empty());
        let up = s.hook(&notification("Add a map\nof our days\n[In Erga: Open: Trip]"));
        assert_eq!(up.frames, [json!({ "type": "RUN_STARTED", "threadId": "s1", "runId": "panel-1" })]);
        // Another task's notification starts a run of the session's own.
        s.hook(&hook("Stop", json!({})));
        let other = s.hook(&hook("UserPromptSubmit", json!({ "prompt": "<task-notification><summary>a build</summary></task-notification>" })));
        assert_eq!(types(&other.frames), ["RUN_STARTED"]);
        assert_ne!(other.frames[0]["runId"], "panel-1");
        assert!(other.frames[0].get("input").is_none());
    }

    #[test]
    fn a_tool_call_and_its_result_with_long_text_cut() {
        let mut s = state();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Write it" })));
        let long = "x".repeat(5000);
        let pre = s.hook(&hook("PreToolUse", json!({ "tool_name": "Write", "tool_use_id": "c1", "tool_input": { "file_path": "map.js", "content": long } })));
        assert_eq!(types(&pre.frames), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
        let args: Value = serde_json::from_str(pre.frames[1]["delta"].as_str().unwrap()).unwrap();
        assert_eq!(args["file_path"], "map.js");
        assert_eq!(args["content"].as_str().unwrap().chars().count(), 2001);
        assert!(pre.reply.is_none());
        let post = s.hook(&hook("PostToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_response": { "stdout": "ok", "stderr": "warn" } })));
        assert_eq!(types(&post.frames), ["TOOL_CALL_RESULT"]);
        assert_eq!(post.frames[0]["content"], "ok\nwarn");
        assert_eq!(post.frames[0]["toolCallId"], "c1");
    }

    fn asked(s: &mut State) -> Up {
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Make it smaller" })));
        let input = json!({ "command": "sips -Z 1600 winter.jpg" });
        s.hook(&hook("PreToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_input": input })));
        s.hook(&hook("PermissionRequest", json!({ "tool_name": "Bash", "tool_input": input })))
    }

    #[test]
    fn a_permission_prompt_waits_for_the_panel_or_the_terminal() {
        // The panel answers: the hook gets the decision, and the next run goes on from the one that asked.
        let mut s = state();
        let ask = asked(&mut s);
        assert!(ask.wait);
        assert_eq!(types(&ask.frames), ["RUN_FINISHED"]);
        let interrupt = &ask.frames[0]["outcome"]["interrupts"][0];
        assert_eq!(interrupt["toolCallId"], "c1");
        assert_eq!(interrupt["reason"], "permission");
        let resume = json!({ "threadId": "s1", "runId": "panel-2", "messages": [], "resume": [{ "interruptId": interrupt["id"], "status": "resolved", "payload": { "approved": true } }] });
        let down = s.down(&resume);
        assert_eq!(down.answer.unwrap()["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(down.frames[0]["runId"], "panel-2");
        assert_eq!(down.frames[0]["parentRunId"], ask.frames[0]["runId"]);
        assert!(down.print.is_none());
        let post = s.hook(&hook("PostToolUse", json!({ "tool_use_id": "c1", "tool_response": { "stdout": "" } })));
        assert!(!post.release);
        assert_eq!(types(&post.frames), ["TOOL_CALL_RESULT"]);

        // A deny in the panel.
        let mut s = state();
        let ask = asked(&mut s);
        let id = ask.frames[0]["outcome"]["interrupts"][0]["id"].clone();
        let deny = s.down(&json!({ "runId": "p", "messages": [], "resume": [{ "interruptId": id, "status": "resolved", "payload": { "approved": false } }] }));
        assert_eq!(deny.answer.unwrap()["hookSpecificOutput"]["decision"]["behavior"], "deny");

        // The terminal answers first: the tool's result comes, the hook that waits gets no answer, and a run goes on.
        let mut s = state();
        let ask = asked(&mut s);
        let post = s.hook(&hook("PostToolUse", json!({ "tool_use_id": "c1", "tool_response": { "stdout": "" } })));
        assert!(post.release);
        assert_eq!(types(&post.frames), ["RUN_STARTED", "TOOL_CALL_RESULT"]);
        assert_eq!(post.frames[0]["parentRunId"], ask.frames[0]["runId"]);
        // The panel's answer after that is too late: it answers nothing.
        let late =
            s.down(&json!({ "runId": "p", "messages": [], "resume": [{ "interruptId": "i-t-2", "status": "resolved", "payload": { "approved": true } }] }));
        assert!(late.answer.is_none() && late.frames.is_empty());
        // The notification that says "Claude needs your permission" is not the terminal's answer.
        let mut s = state();
        asked(&mut s);
        assert!(!s.hook(&hook("Notification", json!({ "message": "Claude needs your permission" }))).release);
    }

    #[test]
    fn a_stop_from_the_panel_ends_the_turn_at_the_next_tool() {
        // Before a tool: the tool does not run.
        let mut s = state();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go" })));
        s.down(&json!({ "cancel": "r-t-1" }));
        let pre = s.hook(&hook("PreToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_input": { "command": "sleep 9" } })));
        let reply = pre.reply.unwrap();
        assert_eq!(reply["continue"], false);
        assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(types(&pre.frames), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_FINISHED"]);
        assert_eq!(pre.frames[4]["outcome"]["type"], "cancelled");
        // After a tool that ran.
        let mut s = state();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go" })));
        s.hook(&hook("PreToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_input": {} })));
        s.down(&json!({ "cancel": "r" }));
        let post = s.hook(&hook("PostToolUse", json!({ "tool_use_id": "c1", "tool_response": "done" })));
        assert_eq!(post.reply.unwrap(), json!({ "continue": false, "stopReason": STOPPED }));
        assert_eq!(types(&post.frames), ["TOOL_CALL_RESULT", "RUN_FINISHED"]);
        // With no run open, a stop does nothing later.
        let mut s = state();
        s.down(&json!({ "cancel": "r" }));
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go" })));
        assert!(s.hook(&hook("PreToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_input": {} }))).reply.is_none());
    }

    #[test]
    fn a_read_only_helper_sends_the_session_up_and_takes_nothing_down() {
        let mut s = State::new("s1", "t", true);
        let down = s.down(&json!({ "runId": "p1", "messages": [{ "id": "u", "role": "user", "content": "Hi" }] }));
        assert!(down.print.is_none());
        assert_eq!(types(&down.frames), ["RUN_STARTED", "RUN_ERROR"]);
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go" })));
        s.hook(&hook("PreToolUse", json!({ "tool_name": "Bash", "tool_use_id": "c1", "tool_input": {} })));
        let ask = s.hook(&hook("PermissionRequest", json!({ "tool_name": "Bash", "tool_input": {} })));
        assert!(!ask.wait && ask.frames.is_empty());
        s.down(&json!({ "cancel": "r" }));
        assert!(s.hook(&hook("PostToolUse", json!({ "tool_use_id": "c1", "tool_response": "" }))).reply.is_none());
    }

    fn codex() -> State {
        let mut s = State::new("s1", "t", false);
        s.codex = true;
        s
    }

    #[test]
    fn codex_gives_the_text_at_the_turns_end_and_a_queued_message_comes_back_as_the_prompt() {
        let mut s = codex();
        let down =
            s.down(&json!({ "runId": "panel-1", "messages": [{ "id": "u", "role": "user", "content": "Add a map" }], "context": [{ "value": "Open: Trip" }] }));
        let queued = down.print.unwrap();
        assert_eq!(queued, "Add a map\n[In Erga: Open: Trip]");
        let up = s.hook(&hook("UserPromptSubmit", json!({ "prompt": queued, "turn_id": "turn-1" })));
        assert_eq!(up.frames, [json!({ "type": "RUN_STARTED", "threadId": "s1", "runId": "panel-1" })]);
        let end = s.hook(&hook("Stop", json!({ "turn_id": "turn-1", "last_assistant_message": "The map is on the page." })));
        assert_eq!(types(&end.frames), ["TEXT_MESSAGE_CHUNK", "RUN_FINISHED"]);
        assert_eq!(end.frames[0]["delta"], "The map is on the page.");
        // The same text typed in the terminal later is a prompt of the terminal's.
        let typed = s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Add a map\n[In Erga: Open: Trip]", "turn_id": "turn-2" })));
        assert_eq!(typed.frames[0]["input"]["messages"][0]["content"], "Add a map\n[In Erga: Open: Trip]");
    }

    #[test]
    fn codex_asks_the_panel_only_in_a_turn_that_the_panel_started() {
        let input = json!({ "command": "rm -r build" });
        // A turn from the terminal: no card, and the hook does not wait (the terminal shows its own prompt).
        let mut s = codex();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Clean up", "turn_id": "t1" })));
        s.hook(&hook("PreToolUse", json!({ "tool_name": "shell", "tool_use_id": "c1", "tool_input": input, "turn_id": "t1" })));
        let ask = s.hook(&hook("PermissionRequest", json!({ "tool_name": "shell", "tool_input": input, "turn_id": "t1" })));
        assert!(!ask.wait && ask.frames.is_empty());
        // A turn from the panel: the card, and the hook waits for its answer.
        let mut s = codex();
        let queued = s.down(&json!({ "runId": "p1", "messages": [{ "id": "u", "role": "user", "content": "Clean up" }] })).print.unwrap();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": queued, "turn_id": "t1" })));
        s.hook(&hook("PreToolUse", json!({ "tool_name": "shell", "tool_use_id": "c1", "tool_input": input, "turn_id": "t1" })));
        let ask = s.hook(&hook("PermissionRequest", json!({ "tool_name": "shell", "tool_input": input, "turn_id": "t1" })));
        assert!(ask.wait);
        assert_eq!(ask.frames[0]["outcome"]["interrupts"][0]["toolCallId"], "c1");
    }

    #[test]
    fn codex_stops_with_its_own_interrupt_and_the_interrupt_hook_ends_the_run() {
        let mut s = codex();
        assert!(s.down(&json!({ "cancel": "r" })).interrupt.is_none());
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go", "turn_id": "turn-7" })));
        assert_eq!(s.down(&json!({ "cancel": "r" })).interrupt.as_deref(), Some("turn-7"));
        let end = s.hook(&hook("Interrupt", json!({ "turn_id": "turn-7" })));
        assert_eq!(end.frames[0]["outcome"]["type"], "cancelled");
        // Claude Code has no such interrupt: its stop is the next tool hook's.
        let mut s = state();
        s.hook(&hook("UserPromptSubmit", json!({ "prompt": "Go" })));
        assert!(s.down(&json!({ "cancel": "r" })).interrupt.is_none());
    }
}
