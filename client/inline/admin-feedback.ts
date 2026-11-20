// The Feedback page's messages (/admin/feedback, server/admin/feedback.ts): Resolve on an unresolved one, Reopen on a
// resolved one. A click saves the new status by itself (set_feedback), the save mark left of the buttons' bar says how
// far it is, and the message goes to the other list, in its place by its time.

import { runTool } from "../common/admin-post";
import { saveMark } from "../common/admin-save";

export default function adminFeedback(): void {
  const mark = saveMark();
  const all = document.querySelector<HTMLElement>(".feedback-lists")!;
  const list = (status: string) => all.querySelector<HTMLElement>(`ol.feedback[data-status=${status}]`)!;
  /** The lists as they are now: the empty line, and how many are resolved. */
  const shown = () => {
    const open = list("unresolved").children.length,
      done = list("resolved").children.length;
    list("unresolved").hidden = !open;
    all.querySelector<HTMLElement>(".changes-empty")!.hidden = !!open;
    all.querySelector<HTMLElement>("details.resolved")!.hidden = !done;
    all.querySelector(".resolved .count")!.textContent = String(done);
  };
  all.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button.resolve");
    const li = button?.closest<HTMLElement>("li");
    if (!button || !li) return;
    const id = li.dataset.id!,
      to = li.dataset.status == "resolved" ? "unresolved" : "resolved",
      key = `feedback:${id}`;
    const save = async () => {
      button.disabled = true;
      mark.set(key, "saving");
      try {
        await runTool("set_feedback", { id, status: to });
      } catch (err) {
        button.disabled = false;
        return mark.set(key, "error", { title: "The feedback's status is not saved", detail: (err as Error).message }, save);
      }
      // Its place in the other list: the newest first.
      const after = [...list(to).children].find((o) => Number((o as HTMLElement).dataset.at) < Number(li.dataset.at));
      list(to).insertBefore(li, after ?? null);
      li.dataset.status = to;
      button.textContent = to == "resolved" ? "Reopen" : "Resolve";
      button.disabled = false;
      shown();
      mark.set(key, "saved");
    };
    void save();
  });
}
