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
      let bundle: string | null = null, error: string | null = null, buf = "";
      const decoder = new TextDecoder();
      const line = (text: string) => {
        if (!text.trim()) return;
        let m: { log?: string; bundle?: string; error?: string };
        try { m = JSON.parse(text); } catch { log(text); return; }
        if (m.log != null) log(m.log);
        if (m.bundle != null) bundle = m.bundle;
        if (m.error != null) error = m.error;
      };
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(line);
        signal?.throwIfAborted();
      }
      line(buf);
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
