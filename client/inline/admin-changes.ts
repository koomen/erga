// The Change log's script (/admin/changes, server/admin/changes.ts), on its first page: each new line shows at the top
// as it's made, whoever made the change (client/common/live-rows.ts).

import { liveList } from "../common/live-rows";
import times from "./times";

export default function adminChanges(): void {
  const list = document.querySelector<HTMLElement>("ol.changes[data-live-kind]");
  if (!list) return;
  liveList(
    list,
    {
      wire: () => times(),
      changed: () => {
        document.querySelector<HTMLElement>(".changes-empty")!.hidden = !!list.children.length;
      },
    },
    window.ergaView?.signal
  );
}
