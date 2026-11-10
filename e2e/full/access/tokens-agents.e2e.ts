// Pete's rule: an agent never makes a token of any kind. Each route that makes a token, a key or a share link refuses
// a caller with an agent's token, an admin's too, and a request for a token still waits for the person.
import { expect, servers, test } from "../../helpers/fixtures";
import { mint, publish, tool } from "./access";

await servers.main();

test("an agent with a token makes no token, no share link, no edit key and no API key; it approves no request", async () => {
  const root = (await servers.main()).root;
  const origin = new URL(root).origin;
  for (const scope of ["documents", "admin"]) {
    const agent = (await mint(root, null, { label: `Agent ${scope}`, scope })).token;
    expect(agent).toBeTruthy();
    const doc = await publish(root, agent, `Tokens ${scope}`);
    const post = (path: string, body: string, type = "application/json") =>
      fetch(root + path, {
        method: "POST",
        headers: { Authorization: `Bearer ${agent}`, Origin: origin, "Content-Type": type },
        body,
        redirect: "manual",
      });
    const asked = (await (
      await fetch(`${root}/api/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "A second agent", scope: "documents" }),
      })
    ).json()) as { code: string; user_code: string };

    const tries: [string, Response][] = [
      ["a new token", await post("/tokens/new", JSON.stringify({ label: "More", scope: "documents" }))],
      ["an approval", await post("/tokens/approve", `code=${asked.user_code}&answer=approve`, "application/x-www-form-urlencoded")],
      ["the share link's token", await post(`/d/${doc.id}/api/share`, "{}")],
      ["a new share link's token", await post(`/d/${doc.id}/api/share`, JSON.stringify({ rotate: true }))],
      ["an edit key", await post(`/d/${doc.id}/api/key`, "{}")],
      ["an API key", await post("/api/agent/keys", JSON.stringify({ name: "anthropic", value: "sk-ant-api03-x" }))],
    ];
    for (const [what, r] of tries) {
      const body = await r.text();
      expect([scope, what, r.status]).toEqual([scope, what, 403]);
      expect([what, /erga_[A-Za-z0-9]/.test(body)]).toEqual([what, false]);
    }
    // The request was not approved: its agent still waits.
    const poll = await fetch(`${root}/api/auth/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: asked.code }),
    });
    expect(((await poll.json()) as { token?: string }).token).toBeUndefined();
    // And no tool makes one: the agent's person still has only the tokens they made.
    const mine = JSON.parse((await tool(root, agent, "documents", { op: "whoami", limit: 50 })).text) as { tokens: { label: string }[] };
    expect(mine.tokens.some((t) => t.label == "More" || t.label == "A second agent" || t.label == "Share button")).toBe(false);
  }
});
