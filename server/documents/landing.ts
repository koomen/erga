// The front page's document (the landing_document setting), and making it from the repo's
// assets/landing/ when there's none (seedLanding). The viewer on it at / is view.ts's.

import { type DocRow, newDocId } from "../directory/index.ts";
import { type Platform } from "../platform.ts";
import { makeDoc } from "./make.ts";

/**
 * The document the front page shows now: the setting's (and, while a seed in this isolate has claimed it but not yet
 * moved it to /<owner>/landing, that seed's answer, at its address). Null when there's none yet (landingPage makes one).
 */
export async function frontDocument(platform: Platform): Promise<DocRow | null> {
  const named = await platform.directory.landing();
  const running = seeding.get(platform.directory);
  if (named && running && named.slug == named.id) return (await running) ?? named;
  return named;
}

/**
 * The front page's document: the one landing_document names, else (unset,
 * or naming a document that's gone) a new one made from the repo's assets/landing/
 * (seedLanding). Null only when the deploy locks the setting to a document
 * that isn't there, or there's nobody to own one.
 */
export async function landingDocument(platform: Platform): Promise<DocRow | null> {
  return (await landingPage(platform))?.doc ?? null;
}

/** The front page's document (landingDocument) and its page: the one round trip to its host tells both that it's there and which file to show. */
export async function landingPage(platform: Platform): Promise<{ doc: DocRow; index: string } | null> {
  const doc = await platform.directory.landing();
  const index = doc && (await platform.docs.index(doc));
  if (doc && index != null) return { doc, index };
  const made = await seedLanding(platform);
  const madeIndex = made && (await platform.docs.index(made));
  return made && madeIndex != null ? { doc: made, index: madeIndex } : null;
}

/** Seeds under way, by directory (one per database), so a burst of first requests in one isolate makes one document. */
const seeding = new WeakMap<object, Promise<DocRow | null>>();

/**
 * Makes the front page from the repo's assets/landing/ (built into the Worker) the
 * first time anyone asks for it, and again when the one it named was deleted
 * or an admin reset the setting: a document of the landing owner's at
 * /<owner>/landing, which the other bootstrap admins may edit too, and sets
 * landing_document to it. No deploy step does this; the server does.
 * Requests at once in one isolate share one seed; across isolates the setting
 * is claimed compare-and-set (ServerConfig.claim), and a seed that loses
 * deletes its document and takes the winner's. Each seed makes its document
 * at its id (/<owner>/<id>), and only the winner moves to /<owner>/landing,
 * once it has won: so a loser never holds "landing" while the winner looks
 * for a free slug, which gave the winner "landing-2". A setting an admin
 * chose (a document that's there) is never touched, nor one the deploy locks.
 */
export function seedLanding(platform: Platform): Promise<DocRow | null> {
  const key = platform.directory;
  const running = seeding.get(key);
  if (running) return running;
  const run = (async () => {
    const config = platform.directory.config;
    const project = platform.landing;
    if (config.isLocked("landing_document") || !project?.owner) return null;
    const index = project.files["index.html"] != null ? "index.html" : null;
    if (!index) return null;
    // Read afresh (settings are remembered a few seconds): another isolate may have seeded it just now.
    const live = async (stored: string | null) => {
      let ref: unknown = null;
      try { ref = stored == null ? null : JSON.parse(stored); } catch { /* not JSON: dangling */ }
      const doc = typeof ref == "string" && ref ? await platform.directory.find(ref) : null;
      return doc && !doc.test && (await platform.docs.exists(doc)) ? doc : null;
    };
    // The winner's document, still at its id, takes its address: landing-2 only if another of the owner's really is at landing.
    // A loser does it too, so the document it answers with has its address already.
    const settle = async (doc: DocRow | null) => (doc && doc.slug == doc.id ? ((await platform.directory.reslug(doc.id, "landing")) ?? doc) : doc);
    const stored = await config.stored("landing_document");
    const there = await live(stored);
    if (there) return there;
    const owner = project.owner.toLowerCase();
    let made: DocRow | null = null;
    for (let tries = 0; !made && tries < 5; tries++) { const id = newDocId(); made = await makeDoc(platform, owner, id, { ...project.files }, { index, slug: id, published: true }); }
    if (!made) return null;
    if (!(await config.claim("landing_document", stored, made.id, owner))) {
      // Another seed won: theirs is the front page, and this one goes.
      if (!(await platform.docs.delete(made))) await platform.directory.remove(made.id);
      return settle(await live(await config.stored("landing_document")));
    }
    made = (await settle(made)) ?? made;
    // The deploy's own doing (its ADMINS), not a person's: the server shares as the owner, with admin power
    // (editing the front page needs that: server/directory/, homeLimit).
    const server = { login: owner, test: false, admin: true };
    for (const login of project.editors) {
      if (login.toLowerCase() == owner) continue;
      await platform.directory.share(server, made.id, login, "editor").catch(() => {});
    }
    return made;
  })().finally(() => seeding.delete(key));
  seeding.set(key, run);
  return run;
}
