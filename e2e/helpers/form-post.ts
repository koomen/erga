// A page's form, sent from a test as a browser sends it. Its POST answers 303 See Other to a page, and what that page
// shows of it (an error, a new token) goes there in a cookie, read once (server/identity/flash.ts): the page, with
// that cookie and the person's own (none: the dev login).
export async function postForm(root: string, path: string, fields: Record<string, string>, cookie: string | null = null) {
  const sent = await fetch(root + path, {
    method: "POST",
    redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: new URL(root).origin },
    body: new URLSearchParams(fields),
  });
  const to = sent.headers.get("location");
  if (sent.status != 303 || !to) return { status: sent.status, location: null, page: await sent.text() };
  const note = sent.headers.getSetCookie().map((c) => c.split(";")[0]);
  const page = await fetch(new URL(to, root), { redirect: "manual", headers: { Cookie: [cookie, ...note].filter(Boolean).join("; ") } });
  return { status: sent.status, location: to, page: await page.text() };
}
