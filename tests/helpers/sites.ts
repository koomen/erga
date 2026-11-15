// A domain's publishing (server/sites/publishing.ts) on fake storage and a fake alarm, as its Durable Object runs it.

import type { DocRow } from "../../server/directory/index.ts";
import { Publishing, type PublishingDeps } from "../../server/sites/publishing.ts";

export interface MemorySite {
  site: Publishing;
  storage: Map<string, unknown>;
  /** When the alarm is set for (null: not set). `ring` runs it, as Cloudflare does. */
  alarm: { at: number | null };
  ring(): Promise<void>;
  /** The documents told of a change, in order. */
  told: string[];
}

/**
 * `auto`: the alarm rings by itself, as on a server. `stored`: what the object's storage holds before it loads.
 * `document` and `current`: the documents there are, and their files now.
 */
export function memorySite(o: {
  stored?: Record<string, unknown>;
  auto?: boolean;
  document: PublishingDeps["document"];
  current: PublishingDeps["current"];
  notify?: (id: string) => Promise<void>;
  testFailures?: boolean;
}): MemorySite {
  const storage = new Map(Object.entries(o.stored ?? {}));
  const alarm = { at: null as number | null };
  const told: string[] = [];
  const ring = async () => {
    if (alarm.at == null) return;
    alarm.at = null;
    await site.alarm();
  };
  const site = new Publishing({
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: (async (a: string | Record<string, unknown>, b?: unknown) => {
        for (const [k, v] of typeof a == "string" ? [[a, b] as const] : Object.entries(a)) storage.set(k, v);
      }) as PublishingDeps["storage"]["put"],
      delete: async (keys) => {
        for (const k of [keys].flat()) storage.delete(k);
      },
      list: async (prefix) => [...storage.keys()].filter((k) => k.startsWith(prefix)),
    },
    alarm: {
      set: async (at) => {
        alarm.at = at;
        if (o.auto) setTimeout(() => void ring(), 0);
      },
      delete: async () => void (alarm.at = null),
    },
    document: o.document,
    current: o.current,
    notify: async (id) => {
      told.push(id);
      await o.notify?.(id);
    },
    mimeOf: (path) => (path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : null),
    testFailures: o.testFailures,
    log: () => {},
  });
  return { site, storage, alarm, ring, told };
}

/** A document's row, as far as a publish reads it. */
export const docRow = (id: string, title = "Home", owner = "-home", slug = "home") => ({ id, owner, slug, title, test: false }) as DocRow;
