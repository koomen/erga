// What the admin pages' scripts (client/inline/admin-*.ts) share: a hint that says how it went, the page again as the
// server has it now, and a POST of a secret (a key, an app's values) to its page. Every other change is an operation
// (client/common/tools.ts).

export { runTool } from "./tools";

/** POSTs `fields` (a secret) to `action` and answers its JSON; the server's error, or a line about the network, as an Error. */
export async function post(action: string, fields: Record<string, string>): Promise<any> {
  const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(
    () => null
  );
  const body = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
  return body;
}

/**
 * Runs a change to the sign-in or the access that may stop the usernames rule that is set. The server refuses such a
 * change (428) with what will happen (server/operations/admin.ts, keepsUsernames): the admin reads it in a dialog.
 * Proceed runs the change again with `proceed`; Cancel (or Escape) answers null, and nothing changed.
 */
export async function proceeds<T>(run: (proceed: { proceed?: true }) => Promise<T>): Promise<T | null> {
  try {
    return await run({});
  } catch (err) {
    if ((err as { status?: number }).status != 428) throw err;
    const d = Object.assign(document.createElement("dialog"), { className: "proceed" });
    d.setAttribute("aria-labelledby", "proceed-title");
    d.innerHTML = `<h2 id="proceed-title">Change how usernames are assigned?</h2><p></p><form method="dialog" class="buttons"><button value="">Cancel</button><button class="primary" value="proceed" autofocus>Proceed</button></form>`;
    d.querySelector("p")!.textContent = (err as Error).message;
    document.body.append(d);
    d.showModal();
    await new Promise((closed) => d.addEventListener("close", closed, { once: true }));
    d.remove();
    return d.returnValue == "proceed" ? run({ proceed: true }) : null;
  }
}

/** `text` in `hint`, red when it's an error. */
export const say = (hint: Element, text: string, error?: boolean) => {
  hint.textContent = text;
  hint.classList.toggle("error", !!error);
};

/** The page again, as the server has it now: in place, so the agent panel carries on. */
export const reload = () => (window.ergaAdmin ? window.ergaAdmin.reload() : location.reload());
