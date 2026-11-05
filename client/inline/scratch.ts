// A scratch document's note (server/pages/scratch.ts), on its page in the viewer and the editor alike: how long it has
// left, counted down each minute (none if it is never deleted), and Save (its owner's), which keeps it (save_document). Saved, the note goes, and the
// address bar takes the document's new address (the editor follows a rename by itself; the viewer doesn't).

export default function scratch(doc: string, expires: number | null): void {
  const note = document.getElementById("erga-scratch");
  const left = document.getElementById("erga-scratch-left");
  if (!note) return;
  const show = () => {
    if (!left || expires == null) return;
    const min = Math.ceil((expires - Date.now()) / 60000);
    const hours = Math.round(min / 60);
    left.textContent =
      min <= 0 ? "in a moment" : min < 60 ? `in ${min} minute${min == 1 ? "" : "s"}` : `in ${hours} hour${hours == 1 ? "" : "s"}`;
  };
  show();
  const timer = expires == null ? 0 : setInterval(show, 30_000);
  const save = document.getElementById("erga-scratch-save") as HTMLButtonElement | null;
  save?.addEventListener("click", async () => {
    save.disabled = true;
    const said = document.getElementById("erga-scratch-said")!;
    said.textContent = "Saving…";
    const r = await fetch("/api/tools/save_document", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ document: doc }),
    }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || body.ok === false) {
      said.textContent = body.error || "Couldn't reach the server: try again.";
      save.disabled = false;
      return;
    }
    clearInterval(timer);
    note.remove();
    const address = body.result?.saved?.address;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]');
    if (typeof address == "string" && meta && !document.body.classList.contains("erga-editing")) {
      meta.content = address;
      const here = ergaPageAddress();
      if (location.pathname != here) history.replaceState(history.state, "", here + location.search + location.hash);
    }
  });
}
