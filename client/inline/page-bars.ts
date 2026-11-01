// The bars of the app's own pages (server/pages/bars.ts, pageBars), after them: their buttons (client/common/bars.ts).

import { mountBars } from "../common/bars";

export default function pageBars(): void {
  mountBars(document, document.body);
}
