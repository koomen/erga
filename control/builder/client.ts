// The pipeline's side of the build container (server.ts, in the container,
// behind worker.ts in the control Worker): asks it to build a commit and
// follows the build's output line by line; the release it hands back is
// the one the pipeline deploys.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { DeployError } from "../deploys/cloudflare-api";
import type { Release } from "../deploys/release-format";
import { unpackRelease } from "../deploys/bundle";
import type { Builder } from "../deploys/branches";
import { runWith } from "../clock";

/** One line of the build's output: a line of its log, the release (a bundle), or why it failed. */
const lineOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      log: Schema.optionalKey(Schema.String),
      bundle: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String),
    })
  )
);

/** A builder behind `fetcher`: the control Worker's own builderFetch (worker.ts), or a service binding to one. */
export function containerBuilder(fetcher: { fetch: typeof fetch }, o: { sleep?: (ms: number) => Promise<void> } = {}): Builder {
  return {
    async build({ commit, branch, source }, log, signal): Promise<Release> {
      let r: Response | null = null;
      // The build's own name: the Worker gives it a container of its own, and a cancel reaches that one.
      const id = crypto.randomUUID();
      // Cancelled: the container stops this build (its commands killed), and the stream is dropped.
      const stop = () => { fetcher.fetch(`http://builder/cancel?id=${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commit }) }).catch(() => {}); };
      signal?.addEventListener("abort", stop, { once: true });
      try {
      // Another build in the container (409), or no container free to start (503, "didn't start"):
      // wait and try again, up to ~10 minutes for 409s and ~5 minutes for 503s.
      let busy = 0,
        waited = 0,
        tries = 0;
      type Asked = { r: Response | null; wait: number | null };
      const ask = Effect.tryPromise({
        try: async (): Promise<Asked> => {
          signal?.throwIfAborted();
          const i = tries++;
          const r = await fetcher.fetch(`http://builder/build?id=${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source, commit, branch }),
            signal,
          });
          if (r.status == 409 && busy < 120) {
            if (busy++ == 0) log("the builder is busy with another build: waiting");
            return { r, wait: 5000 };
          }
          if (r.status == 503 && waited < 5 * 60_000) {
            const why = (await r.text().catch(() => "")).slice(0, 200);
            const ms = Math.min(30_000, 5000 * 2 ** Math.min(3, i));
            log(`waiting for the builder (it answered 503${why ? `: ${why}` : ""}); trying again in ${ms / 1000} s`);
            waited += ms;
            return { r: null, wait: ms };
          }
          return { r, wait: null };
        },
        catch: (e) => e,
      });
      // Asked again after the wait each answer says, at most 200 times in all.
      const again = Schedule.spaced(0).pipe(
        Schedule.setInputType<Asked>(),
        Schedule.modifyDelay(({ input }) => Effect.succeed(input.wait ?? 0))
      );
      r = (await runWith(o.sleep, ask.pipe(Effect.repeat({ schedule: again, times: 199, until: (a) => a.wait == null })))).r;
      if (!r || !r.ok || !r.body)
        throw new DeployError({
          message: `The builder didn't take the build (it answered ${r?.status ?? "nothing"}${r ? `: ${(await r.text().catch(() => "")).slice(0, 300)}` : ""}).`,
        });
      let bundle: string | null = null,
        error: string | null = null;
      for await (const text of ndjsonLines(r.body as unknown as AsyncIterable<Uint8Array>, signal)) {
        if (!text.trim()) continue;
        const read = lineOf(text);
        if (Option.isNone(read)) {
          log(text);
          continue;
        }
        const m = read.value;
        if (m.log != null) log(m.log);
        if (m.bundle != null) bundle = m.bundle;
        if (m.error != null) error = m.error;
      }
      signal?.throwIfAborted();
      if (error) throw new DeployError({ message: `The build failed: ${error}` });
      if (!bundle)
        throw new DeployError({
          message: "The build stopped without a release (the builder's container may have restarted). Deploy again.",
        });
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
