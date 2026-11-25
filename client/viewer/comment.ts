// Comments for a person who may comment and not edit (a commenter: server/documents/view.ts). The page in the frame
// runs its half of the editor for the comments alone (libs/text/ui/mode.ts, `comment`): read-only, with a "Comment"
// button at the selection. This script says so to each page that comes in the frame, with an edit key for the document
// (POST <base>/api/key: it opens the room to read, and names the person for the comment ops), and a new key before
// the last one ends. A comment, a reply and an edit go from the box this window draws over the page, with the
// person's session (client/common/comment-box.ts), never with that key. The page answers "erga-commenting" once its comments are up: from then on it shows each change in
// place, and the viewer's own reload stops (client/viewer/live.ts reads the class).

import { asUser } from "../common/tools";
import { mountCommentBox } from "../common/comment-box";
import { live } from "../live/client";

export type Commenter = { user: string; name: string; color: string; avatar?: string };

export function mountComment(base: string, me: Commenter): void {
  const tab = Math.random().toString(36).slice(2);
  const page = () => document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || "index.html";
  // The box a comment is typed in, over the page (client/common/comment-box.ts): it sends with the person's session.
  mountCommentBox(base.replace(/^\/d\//, ""), page);
  let key = "";
  const say = () => {
    if (!key) return;
    ergaFrames.send({
      type: "erga-mode",
      mode: "edit",
      comment: true,
      doc: location.origin + base,
      key,
      me: { ...me, kind: "person" },
      path: page(),
      tab,
      notes: 0,
    });
  };
  // Signed out (client/live/live.ts): no more keys are asked for, and the page's socket tries no more.
  let out = false;
  live((l) =>
    l.signedOut(() => {
      out = true;
      ergaFrames.send({ type: "erga-out" });
    })
  );
  async function fresh() {
    if (out) return;
    const r = await fetch(asUser(base + "/api/key"), { method: "POST" }).catch(() => null);
    const k = r && r.ok ? ((await r.json().catch(() => null)) as { key?: string; expires?: number } | null) : null;
    if (k?.key) {
      key = k.key;
      say();
    }
    setTimeout(fresh, k?.expires ? Math.max(30_000, k.expires - Date.now() - 120_000) : 30_000);
  }
  // (After client/viewer/nav.ts's own listener: the meta erga-page names the page that came.)
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e)) return;
    if (e.data?.type == "erga-nav") {
      document.body.classList.remove("erga-commenting");
      say();
    } else if (e.data?.type == "erga-commenting") document.body.classList.add("erga-commenting");
  });
  void fresh();
}
