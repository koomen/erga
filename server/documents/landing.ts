// The homepage's document (the landing_document setting), and the homepage project, which the deploy makes.
//
// The homepage project: the project "Erga Homepage" at /_home, which nobody owns and every admin may edit
// (document/names.ts, server/directory/ homeLimit). Each deploy asks the server for it once its release answers
// (POST /api/deploys/home: makeHome), and the server makes it from the repo's assets/landing/ when it has none. No
// request for a page makes it, and it needs no admin. Where there's no homepage, / is the page in the server's code
// (server/pages/home.ts). A server made before the project makes the homepage it has the project, once (adoptLanding):
// the same files and id, a new address (the old one redirects there).

import { SYSTEM } from "../../shared/attribution.ts";
import type { DocRow } from "../directory/index.ts";
import { json, platform, type Route } from "../http.ts";
import { type Platform } from "../platform.ts";
import { makeDoc } from "./make.ts";
import * as Effect from "effect/Effect";
import { HOME_OWNER, HOME_SLUG, HOME_TITLE } from "../../document/names.ts";

/** Where the server put the homepage before the project: /<owner>/landing. */
const OLD_SLUG = "landing";

/** Adoptions under way or done, by directory (one per database): each isolate checks once. */
const adopting = new WeakMap<object, Promise<void>>();

/**
 * Makes the homepage the homepage project, if it's the one the server made before the project (at /<owner>/landing)
 * and there's no homepage project yet: a server's first deploy with it. A document an admin chose
 * as the homepage stays theirs. It becomes nobody's, at /_home, a project
 * called "Erga Homepage", and deploys again (its snapshot names its address). Its files stay as they are.
 */
export function adoptLanding(platform: Platform): Promise<void> {
  const key = platform.directory;
  const known = adopting.get(key);
  if (known) return known;
  const run = (async () => {
    const doc = await platform.directory.landing();
    if (!doc || doc.owner == HOME_OWNER || doc.slug != OLD_SLUG) return;
    const home = await platform.directory.adoptHome(doc.id);
    if (home?.owner != HOME_OWNER) return;
    const route = { id: home.id, owner: home.owner, test: false };
    await platform.docs.treeOp(route, { op: "make_project" });
    await platform.docs.rename(route, { id: HOME_OWNER, name: "Erga" }, { title: HOME_TITLE });
    await platform.home.deploy();
  })().catch((e) => console.log(`couldn't make the homepage the homepage project: ${e}`));
  adopting.set(key, run);
  return run;
}

/** The homepage's document, if the setting names one that is there with its page; else null (/new?from=landing copies it). */
export async function landingDocument(platform: Platform): Promise<DocRow | null> {
  const doc = await platform.directory.landing();
  return doc && (await platform.docs.index(doc)) != null ? doc : null;
}

/** What makeHome did: it made the homepage project, there is one already, or this server has no files to make it from. */
export type HomeMade = "made" | "there" | "none";

/** Makings under way, by directory (one per database): asks at once in one isolate share one. */
const making = new WeakMap<object, Promise<HomeMade>>();

/**
 * The deploy's step: makes the homepage project (/_home) from the repo's assets/landing/ (built into the Worker), when
 * the server has none. It is the homepage (the server's own write of landing_document) unless the setting names a
 * document that is there, or the deploy locks it. Asked again, it does nothing. Two isolates at once: each makes its
 * project at its id, the one that gets /_home keeps it, and the other deletes its own.
 */
export function makeHome(platform: Platform): Promise<HomeMade> {
  const key = platform.directory;
  const running = making.get(key);
  if (running) return running;
  const run = (async (): Promise<HomeMade> => {
    await adoptLanding(platform);
    const dir = platform.directory;
    if (await dir.locate(HOME_OWNER, HOME_SLUG)) return "there";
    const files = await platform.landing?.files();
    const index = files?.["index.html"] != null ? "index.html" : null;
    if (!files || !index) return "none";
    const made = await makeDoc(
      platform,
      HOME_OWNER,
      { ...files },
      { index, atId: true, published: true, kind: "project", title: HOME_TITLE }
    );
    if (!made) return "none";
    if (!(await dir.takeHome(made.id))) {
      if (!(await platform.docs.delete(made))) await dir.remove(made.id);
      return "there";
    }
    if (!dir.config.isLocked("landing_document") && !(await dir.landing()))
      await dir.config.claim("landing_document", await dir.config.stored("landing_document"), made.id, SYSTEM);
    return "made";
  })().finally(() => making.delete(key));
  making.set(key, run);
  return run;
}

/** POST /api/deploys/home: the deploy asks for the homepage project ({ home: "made" | "there" | "none" }). */
export const makeHomeRoute: Route = Effect.gen(function* () {
  const p = yield* platform;
  return json({ home: yield* Effect.promise(() => makeHome(p)) });
});
