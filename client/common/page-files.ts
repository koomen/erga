// Tracks static vs. runtime-fetched document files for an open page (client/inline/reader.ts) and applies non-HTML
// file updates without overflowing the browser's Resource Timing buffer: unused files and fetch/XHR data files skip
// reloading (and data files emit `erga-files-changed`), linked stylesheets hot-swap via CSSOM, and used static scripts
// or media ask to reload.

import { extractDocPath, isStaticResourceInitiator, parseSrcset, usedChangedPaths } from "./live-scope";

const FETCHED_MAX = 500;

export function mountPageFiles(opts: { prefix: () => string; dirty: () => void }): {
  applyFiles(paths: string[], files?: string): Promise<"skip" | "restyled" | "reload">;
  docPath(href: string): string | null;
} {
  const docPath = (href: string) => extractDocPath(href, location.origin, opts.prefix(), location.href);
  const staticUsed = new Set<string>();
  const fetchedUsed = new Set<string>();
  let resourceOverflow = false;
  let observing = false;

  const record = (entry: PerformanceEntry) => {
    const p = docPath(entry.name);
    if (!p) return;
    const init = (entry as PerformanceResourceTiming).initiatorType;
    if (isStaticResourceInitiator(init)) {
      staticUsed.add(p);
    } else {
      if (fetchedUsed.size >= FETCHED_MAX && !fetchedUsed.has(p)) {
        const first = fetchedUsed.values().next().value;
        if (first != null) fetchedUsed.delete(first);
      }
      fetchedUsed.add(p);
    }
  };

  try {
    if (typeof PerformanceObserver == "function") {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record(entry);
      });
      obs.observe({ type: "resource", buffered: true });
      observing = true;
    }
  } catch {
    observing = false;
  }

  try {
    performance.addEventListener("resourcetimingbufferfull", () => {
      if (observing) {
        try {
          for (const entry of performance.getEntriesByType("resource")) record(entry);
          performance.clearResourceTimings();
        } catch {
          resourceOverflow = true;
        }
      } else {
        resourceOverflow = true;
      }
    });
  } catch {}

  function usedDocFiles(): Set<string> {
    const used = new Set<string>(staticUsed);
    const add = (href: string | null | undefined) => {
      if (!href) return;
      const p = docPath(href);
      if (p) used.add(p);
    };
    for (const el of document.querySelectorAll(
      "link[href], script[src], img[src], source[src], video[src], audio[src], iframe[src], embed[src], object[data]"
    )) {
      if (el.hasAttribute("data-erga")) continue;
      add(el.getAttribute("href") || el.getAttribute("src") || el.getAttribute("data"));
    }
    for (const el of document.querySelectorAll("img[srcset], source[srcset]")) {
      for (const u of parseSrcset(el.getAttribute("srcset") || "")) add(u);
    }
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        record(entry);
        if (isStaticResourceInitiator((entry as PerformanceResourceTiming).initiatorType)) add(entry.name);
      }
    } catch {}
    return used;
  }

  let styling: Promise<boolean> = Promise.resolve(true);
  function restyle(paths: string[], files: string): Promise<boolean> {
    styling = styling.then(() => styled(paths, files));
    return styling;
  }

  async function styled(paths: string[], files: string): Promise<boolean> {
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')];
    const jobs: Promise<[CSSStyleSheet, string[]] | null>[] = [];
    for (const path of paths) {
      const hit = links.filter((l) => docPath(l.href) == path);
      if (!/\.css$/i.test(path) || !hit.length) return false;
      const text = fetch(files + path.split("/").map(encodeURIComponent).join("/"), { cache: "no-store" }).then((r) =>
        r.ok ? r.text() : null
      );
      for (const l of hit)
        jobs.push(
          text.then((t) => {
            if (t == null || !l.sheet || /@import/i.test(t)) return null;
            const fresh = new CSSStyleSheet({ baseURL: l.href });
            fresh.replaceSync(t);
            return [l.sheet, [...fresh.cssRules].map((r) => r.cssText)];
          })
        );
    }
    try {
      const done = await Promise.all(jobs);
      if (done.some((d) => !d)) return false;
      for (const [sheet, rules] of done as [CSSStyleSheet, string[]][]) {
        while (sheet.cssRules.length) sheet.deleteRule(0);
        rules.forEach((r, i) => sheet.insertRule(r, i));
      }
    } catch {
      return false;
    }
    opts.dirty();
    return true;
  }

  async function applyFiles(paths: string[], files = location.origin + opts.prefix()): Promise<"skip" | "restyled" | "reload"> {
    const decision = usedChangedPaths(paths, usedDocFiles(), resourceOverflow, fetchedUsed);
    if (decision.action != "reload" && decision.dataPaths?.length) {
      dispatchEvent(new CustomEvent("erga-files-changed", { detail: { paths: decision.dataPaths } }));
    }
    if (decision.action == "skip") return "skip";
    if (decision.action == "reload") return "reload";
    return (await restyle(decision.paths, files)) ? "restyled" : "reload";
  }

  return { applyFiles, docPath };
}
