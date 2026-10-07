// The viewer's controls fade once the page is scrolled, on a document's page (the page in a frame on its own origin)
// (tests/fade.ts, viewer()). The band's colour in every frame of the fade is a bench: fade-band.bench.e2e.ts.
import { fadeStates } from "./fade-states";

fadeStates("doc");
