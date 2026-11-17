// The default homepage: the project "Erga Homepage" at /_home, which nobody owns and every admin may edit
// (document/model/names.ts, server/directory/ homeRole). It is a document like any other: it can be published to a domain,
// or not. The server's scheduled run asks for it each minute (server/health.ts, tick: makeHome). A server that has
// none makes it from the repo's assets/landing/, and publishes it to the Erga domain, so a new server shows it at /
// within a minute of its first deploy. A server that has it does nothing: a later run never changes what is
// published. No request makes it, and it needs no admin.

import { byLine, SYSTEM } from "../../shared/attribution.ts";
import { type Platform } from "../platform.ts";
import { ERGA } from "../sites/index.ts";
import { makeDoc } from "./make.ts";
import { HOME_OWNER, HOME_SLUG, HOME_TITLE } from "../../document/model/names.ts";

/** What makeHome did: it made the default homepage, there is one already, or this server has no files to make it from. */
export type HomeMade = "made" | "there" | "none";

/** Makings under way, by directory (one per database): asks at once in one isolate share one. */
const making = new WeakMap<object, Promise<HomeMade>>();

/**
 * The scheduled run's step: makes the default homepage (/_home) from the repo's assets/landing/ (built into the Worker), when
 * the server has none, and publishes it to the Erga domain, unless another document has that domain. Asked again, it
 * does nothing. Two isolates at once: each makes its project at its id, the one that gets /_home keeps it, and the
 * other deletes its own.
 */
export function makeHome(platform: Platform): Promise<HomeMade> {
  const key = platform.directory;
  const running = making.get(key);
  if (running) return running;
  const run = (async (): Promise<HomeMade> => {
    const dir = platform.directory;
    if (await dir.locate(HOME_OWNER, HOME_SLUG)) return "there";
    const files = await platform.landing?.files();
    const index = files?.["index.html"] != null ? "index.html" : null;
    if (!files || !index) return "none";
    const made = await makeDoc(platform, HOME_OWNER, { ...files }, { index, atId: true, uploaded: true, title: HOME_TITLE });
    if (!made) return "none";
    if (!(await dir.takeHome(made.id))) {
      if (!(await platform.docs.delete(made))) await dir.remove(made.id);
      return "there";
    }
    const site = platform.site(ERGA);
    const by = byLine(SYSTEM);
    if (!(await site.link({ doc: made.id, bars: true, replace: false, by })).refused) await site.publish(made.id, by);
    return "made";
  })().finally(() => making.delete(key));
  making.set(key, run);
  return run;
}
