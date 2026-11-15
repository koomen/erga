// Publishing: a document's domain and its header bar there (set_publishing), and its current version live on that
// domain (publish_document). Admins only, for now. ls answers the state (publishingOf), which Document settings show to
// everyone who may edit the document. The link is the domain's own state (server/sites/state.ts): the Sites row of
// /admin/settings reads the same.

import * as Schema from "effect/Schema";
import type { DocRow } from "../directory/index.ts";
import { domainName, domainNamed, ERGA, ergaName, forgetSite, isServed, LIVE_FILES, sitesOf, type SiteStatus } from "../sites/index.ts";
import { byLine } from "../../shared/attribution.ts";
import { addressOf } from "../../document/names.ts";
import { type Caller, described, DOCUMENT, findDocument, iso, type Operation, OperationError, platformOf, said, str } from "./operation.ts";

/** A domain as "Publish to" lists it: its name, and the document that has it now (null: free). */
interface Choice {
  domain: string;
  /** The Erga domain: the only one where the header bar can show. */
  erga: boolean;
  document: { id: string; title: string; address: string } | null;
}

/**
 * A document's publishing, for ls: the domains to choose from, its own (null: not published), its header bar there,
 * how its publish goes, what the domain serves now, and whether the caller may change it (canPublish: admin power;
 * locked: an admin acting without it, through a token without the admin scope).
 */
export async function publishingOf(caller: Caller, doc: DocRow) {
  const { dir, who } = caller;
  const platform = platformOf(caller);
  const erga = ergaName(platform, caller.origin);
  const [sites, admin, unlocked] = await Promise.all([sitesOf(platform), dir.users.isAdmin(who), dir.users.actsAsAdmin(who)]);
  const domains: Choice[] = await Promise.all(
    sites.map(async ({ domain, status }) => {
      const has = status.doc ? await dir.get(status.doc) : null;
      return {
        domain: domainName(domain, erga),
        erga: domain == ERGA,
        document: has && { id: has.id, title: has.title, address: addressOf(has) },
      };
    })
  );
  const mine = sites.find((s) => s.status.doc == doc.id);
  const s = mine?.status;
  // What the domain serves is this document's version, or (after a replace) still the one before's.
  const own = s?.live?.doc == doc.id ? s.live : null;
  return {
    domains,
    domain: mine ? domainName(mine.domain, erga) : null,
    bars: !!s && mine.domain == ERGA && s.bars,
    state: s?.state ?? "free",
    at: iso(own?.at),
    version: own?.version ?? null,
    /** The domain serves something now (this document's version, or the one before's): "Not published" takes it away. */
    serving: !!s?.live,
    error: s?.error ?? null,
    by: s?.by ?? null,
    canPublish: unlocked,
    locked: admin && !unlocked,
  };
}

/** How long publish_document waits for the publish to end (it usually takes well under a second). */
const PUBLISH_WAIT_MS = 30_000;

const named = (document: unknown) => (typeof document == "string" && document.trim() ? said(document) : "the document open on the page");

export const PUBLISHING_OPERATIONS: Operation[] = [
  {
    name: "set_publishing",
    ui: 'Document settings (the editor), Publishing: "Publish to", and "Show the Erga header bar"',
    label: "Set the document's publishing",
    activity: "setting the document's domain",
    admin: true,
    description: "Sets the document's domain, or none, and the Erga header bar on the published site.",
    // Each change is the user's to approve: above all "Not published", which takes a site down, and a replace, which
    // takes a domain from another document.
    asks: (args) =>
      args.domain === ""
        ? `Unpublish ${named(args.document)}: its domain answers with nothing from then on`
        : typeof args.domain == "string"
          ? `Link ${named(args.document)} to ${said(args.domain)}${args.replace === true ? " in place of the document that has it" : ""}`
          : typeof args.bars == "boolean"
            ? `Turn ${args.bars ? "on" : "off"} the Erga header bar on the published site of ${named(args.document)}`
            : `Change the publishing of ${named(args.document)}`,
    parameters: Schema.Struct({
      document: DOCUMENT,
      domain: Schema.optionalKey(str('One of the server\'s domains (ls: publishing.domains); "": not published.')),
      bars: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "The Erga header bar on the published site: only on the Erga domain." })
      ),
      replace: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Take the domain from the document that has it: only after your user says so." })
      ),
    }),
    run: async (args, caller) => {
      const platform = platformOf(caller);
      const doc = await findDocument(caller, args.document, "edit");
      const erga = ergaName(platform, caller.origin);
      const sites = await sitesOf(platform);
      const now = sites.find((s) => s.status.doc == doc.id) ?? null;
      let to = now?.domain ?? null;
      if (typeof args.domain == "string") {
        to = args.domain.trim() ? domainNamed(platform, erga, args.domain) : null;
        if (args.domain.trim() && to == null)
          throw new OperationError({
            message: `This server has no domain ${said(args.domain)}. Its domains: ${sites.map((s) => domainName(s.domain, erga)).join(", ")}.`,
            status: 400,
          });
      }
      // The bar: as given; else as it is on the same domain; on the Erga domain, on at first.
      const bars = typeof args.bars == "boolean" ? args.bars : to != null && to == now?.domain ? now.status.bars : to == ERGA;
      if (bars && to != ERGA) throw new OperationError({ message: `The Erga header bar can only be shown on ${erga}.`, status: 400 });
      const by = byLine(caller.who.login, caller.who.via);
      if (to != null) {
        const { refused } = await platform.site(to).link({ doc: doc.id, bars, replace: args.replace === true, by });
        if (refused && "claimed" in refused) {
          const has = await caller.dir.get(refused.claimed);
          throw new OperationError({
            message: `${has ? `${has.title} (${addressOf(has)})` : "Another document"} is published to ${domainName(to, erga)}. Ask your user, then call this again with replace: true. Visitors see that document until this one is published.`,
            status: 409,
          });
        }
      }
      // The domain it leaves answers with nothing from now on.
      if (now && now.domain != to) await platform.site(now.domain).unlink(doc.id);
      await changed(caller, [now?.domain, to]);
      return { document: described(doc, caller), publishing: await publishingOf(caller, doc) };
    },
  },
  {
    name: "publish_document",
    ui: "Document settings (the editor), Publishing: Publish",
    label: "Publish the document",
    activity: "publishing the document",
    admin: true,
    description:
      "Puts the document's current version live on its domain: answers when it is live, with each file's live address (live.files).",
    parameters: Schema.Struct({ document: DOCUMENT }),
    asks: (args) => `Publish ${named(args.document)} to its domain as it is now`,
    run: async (args, caller) => {
      const platform = platformOf(caller);
      const doc = await findDocument(caller, args.document, "edit");
      const at = (await sitesOf(platform)).find((s) => s.status.doc == doc.id);
      if (!at) throw new OperationError({ message: "This document has no domain: choose one first (set_publishing).", status: 409 });
      const site = platform.site(at.domain);
      let status: SiteStatus = (await site.publish(doc.id, byLine(caller.who.login, caller.who.via))).status;
      for (const end = Date.now() + PUBLISH_WAIT_MS; status.state == "publishing" && Date.now() < end; ) {
        await new Promise((done) => setTimeout(done, 100));
        status = await site.status();
      }
      await changed(caller, [at.domain]);
      const served = await site.served(null);
      // Where it is live: on the Erga domain, the app's origin; on a custom one, the same protocol and port there.
      const origin = caller.origin ? new URL(caller.origin) : null;
      if (origin && at.domain != ERGA) origin.hostname = at.domain;
      const root = origin ? origin.origin : "";
      const page = served && !served.same && isServed(served.served) ? served.served.page : null;
      const live = page && {
        url: `${root}/`,
        files: Object.fromEntries(
          page.files.map((path) => [
            path,
            at.domain == ERGA ? `${root}${LIVE_FILES}${page.gen}/${encodeURI(path)}` : `${root}/${encodeURI(path)}`,
          ])
        ),
      };
      return { document: described(doc, caller), publishing: await publishingOf(caller, doc), live };
    },
  },
];

/** After a change: this isolate forgets what it serves of each domain (the others ask its site object again), and the open admin pages hear of it. */
async function changed(caller: Caller, domains: (string | null | undefined)[]): Promise<void> {
  const platform = platformOf(caller);
  if (caller.origin) for (const d of new Set(domains)) if (d != null) await forgetSite(platform, new URL(caller.origin), d).catch(() => {});
  await caller.dir.publish([{ key: "setting:sites", to: "admins" }]);
}
