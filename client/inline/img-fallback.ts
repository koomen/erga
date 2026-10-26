// A page's pictures marked data-erga-fallback that don't load go, and the initial under each shows (client/common/img-fallback.ts).

import { imgFallback } from "../common/img-fallback";

export default function pageImgFallback(): void {
  imgFallback(document);
}
