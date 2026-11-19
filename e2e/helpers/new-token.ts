// Makes an agent token as the Settings dialog does (POST /tokens/new, client/agent/settings-dialog.ts: the token is in
// the answer's header x-erga-token): with a sign-in's cookie, else as DEV_LOGIN. The token, or "" and the server's error.
export async function newToken(
  root: string,
  fields: Record<string, string>,
  cookie: string | null = null
): Promise<{ token: string; error: string; status: number }> {
  const r = await fetch(`${root}/tokens/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(fields),
  });
  const text = await r.text();
  let body: { error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { token: r.headers.get("x-erga-token") ?? "", error: body.error ?? "", status: r.status };
}
