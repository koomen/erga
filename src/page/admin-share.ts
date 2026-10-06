// "Share with an agent" on every admin page (admin-layout.ts: the icon in
// the header bar, upper right, as in the editor): the editor's card
// (share-agent.ts), with a factory token (POST /api/factory/tokens) in the
// prompt to paste into an outside agent; New token revokes the old one.
// Built by build.sh to admin-share.js.

import { shareWithAgent } from "./share-agent";

const button = document.getElementById("btn-share");

// A factory token is shown once (the server keeps only its hash): this page keeps it until New token, which revokes it.
const HOURS = 12;
let shared: string | null = null, expires = 0;
if (button) shareWithAgent({
  button,
  title: "Share the factory with an agent",
  intro: "Paste this into an agent that can run commands (Claude Code, Codex…), then explain what you want it to do.",
  note: `Anyone with this token can queue tasks, read them and send them more instructions, as your agent, for ${HOURS} hours. It can't merge, discard or start tasks, push or deploy. New token turns the old one off; so does revoking the admin key you unlocked with.`,
  async token(rotate) {
    if (rotate && shared) {
      const r = await fetch(`/api/factory/tokens/${shared}`, { method: "DELETE" }).catch(() => null);
      if (!r?.ok) throw new Error(r ? `the old one wasn't revoked (the server answered ${r.status})` : "the server didn't answer");
      shared = null;
    }
    const r = await fetch("/api/factory/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Share button", hours: HOURS }), signal: AbortSignal.timeout(10_000) })
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) as { token?: string; id?: string; expires?: number; error?: string } }))
      .catch((e: Error) => { throw new Error(e.name == "TimeoutError" ? "the server didn't answer in time" : "the server didn't answer"); });
    if (!r.ok || !r.body.token) throw new Error(r.body.error ?? `the server answered ${r.status}`);
    shared = r.body.id!;
    expires = r.body.expires!;
    return r.body.token;
  },
  prompt: (token) => promptFor(token, expires),
  dismiss: true,
});

function promptFor(token: string, expires: number): string {
  const origin = location.origin;
  return `I'd like your help with the factory on my Erga server, ${origin}: its task queue, where each task is a branch of Erga that Claude Code builds in a VM of its own. You can queue tasks, read them (status, log, preview, screenshots) and send them more instructions, working as my agent. You can't merge or discard them: I approve each merge myself.

API: ${origin}/api/factory
Token: ${token}
(It works until ${new Date(expires).toLocaleString()}.)

Send the token on every request, as the header "Authorization: Bearer ${token}". Start by reading the guide, which explains the API and how to write tasks:

curl -s -H "Authorization: Bearer ${token}" ${origin}/api/factory/guide

Once you've read the guide, await further instructions.`;
}
