// What the admin pages' scripts (client/inline/admin-*.ts) share: a POST to the server, a hint that says how it went,
// and the page again as the server has it now.

/** POSTs `fields` to `action` and answers its JSON; the server's error, or a line about the network, as an Error. */
export async function post(action: string, fields: Record<string, string>): Promise<any> {
  const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(
    () => null
  );
  const body = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
  return body;
}

/** `text` in `hint`, red when it's an error. */
export const say = (hint: Element, text: string, error?: boolean) => {
  hint.textContent = text;
  hint.classList.toggle("error", !!error);
};

/** The page again, as the server has it now: in place, so the agent panel carries on. */
export const reload = () => (window.ergaAdmin ? window.ergaAdmin.reload() : location.reload());
