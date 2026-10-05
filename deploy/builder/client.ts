// The pipeline's side of the builder (deploy/builder/server.ts, in its
// container, behind deploy/builder/worker.ts): asks it to build a commit and
// follows the build's output line by line; the release it hands back is
// the one the pipeline deploys.

import { DeployError, type Release } from "../cloudflare";
import { unpackRelease } from "../bundle";
import type { Builder } from "../branches";

/** A builder behind `fetcher` (the BUILDER service binding). */
export function containerBuilder(fetcher: { fetch: typeof fetch }, o: { sleep?: (ms: number) => Promise<void> } = {}): Builder {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async build({ commit, branch, source }, log, signal): Promise<Release> {
      let r: Response | null = null;
      // Cancelled: the container stops this build (its commands killed), and the stream is dropped.
      const stop = () => { fetcher.fetch("http://builder/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commit }) }).catch(() => {}); };
      signal?.addEventListener("abort", stop, { once: true });
      try {
      // Another build in the container: wait for it (up to ~10 minutes).
      for (let i = 0; i < 120; i++) {
        signal?.throwIfAborted();
        r = await fetcher.fetch("http://builder/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, commit, branch }), signal });
        if (r.status != 409) break;
        if (i == 0) log("the builder is busy with another build: waiting");
        await sleep(5000);
      }
      if (!r || !r.ok || !r.body) throw new DeployError(`The builder didn't take the build (it answered ${r?.status ?? "nothing"}${r ? `: ${(await r.text().catch(() => "")).slice(0, 300)}` : ""}).`);
      let bundle: string | null = null, error: string | null = null;
      for await (const text of ndjsonLines(r.body as unknown as AsyncIterable<Uint8Array>, signal)) {
        if (!text.trim()) continue;
        let m: { log?: string; bundle?: string; error?: string };
        try { m = JSON.parse(text); } catch { log(text); continue; }
        if (m.log != null) log(m.log);
        if (m.bundle != null) bundle = m.bundle;
        if (m.error != null) error = m.error;
      }
      signal?.throwIfAborted();
      if (error) throw new DeployError(`The build failed: ${error}`);
      if (!bundle) throw new DeployError("The build stopped without a release (the builder's container may have restarted). Deploy again.");
      return unpackRelease(bundle, commit.slice(0, 12));
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
  };
}

/**
 * A stream of NDJSON as its lines, each decoded once, when its newline comes.
 * The release is one line of ~15 MB: the bytes before a newline are kept as
 * they came and never read again until then. (Joining and splitting the text
 * on each chunk, as this did before, read the line over and over: seconds of
 * CPU and hundreds of MB of garbage, which reset the Pipeline object, whose
 * isolate has 128 MB, right after the build.)
 */
export async function* ndjsonLines(body: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [], size = 0;
  const take = (): string => {
    const all = parts.length == 1 ? parts[0] : new Uint8Array(size);
    if (parts.length != 1) { let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } }
    parts = []; size = 0;
    return decoder.decode(all);
  };
  for await (const chunk of body) {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, nl)); size += nl - start;
      start = nl + 1;
      yield take();
    }
    if (start < chunk.length) { parts.push(chunk.subarray(start)); size += chunk.length - start; }
    signal?.throwIfAborted();
  }
  if (size) yield take();
}
