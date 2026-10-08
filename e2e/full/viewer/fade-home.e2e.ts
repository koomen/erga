// The viewer's controls fade once the page is scrolled, on the homepage (served directly, its controls in a shadow root: home.ts)
// (viewer()). The band's colour in every frame of the fade is a bench: fade-band.bench.e2e.ts.
import { fadeStates } from "./fade-states";

await fadeStates("home");
