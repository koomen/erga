// An instance's health, as `bun erga status`, the ops page, auto-deploy and `bun erga promote` read it
// (deploy/cli/running.ts, instanceReader): the server's own report at the instance's public address, which must answer
// as the upload that the entry's Worker runs. On 2026-11-21, status said that staging.erga.dev was healthy while the
// address was down: it read the Worker's health row only, and another Worker had the address.

import { beforeAll, expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { instanceReader, publicHealth } from "../deploy/cli/running";
import { targetFacts } from "../deploy/pipeline/pipeline";
import { mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, next as nextTarget, prepareRelease, SHA1 } from "./helpers/deploys.ts";

beforeAll(async () => {
  // The mock's credential: the reader reads none of this machine's.
  process.env.ERGA_DEPLOY_MOCK = "1";
  await prepareRelease();
}, 120_000);

const next: Entry = { host: "next.example.com", repo: "github.com/koomen/erga", branch: "staging", ...targetFacts(nextTarget()) };
const report = (o: Record<string, unknown>) =>
  Response.json({ ok: true, upload: null, checks: { db: { ok: true, ms: 3 } }, ...o }, { status: o.ok === false ? 503 : 200 });

test("status asks the instance's address: healthy only when it answers, as the upload that the entry's Worker runs", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const asked: string[] = [];
  let answer: () => Response | Promise<Response> = () => new Response("", { status: 500 });
  const ask = instanceReader({ net: mock.fetch, host: async (input) => (asked.push(String(input)), answer()) });
  const v = SHA1.slice(0, 12);
  // A deploy names its upload, and the Worker's version holds the name.
  const upload = bindingsOf(mock.state, "erga-next").ERGA_UPLOAD.text;
  expect(upload).toStartWith(`${v}-`);

  // The server's own report at the address is the instance's health: the health row is not read.
  answer = () => report({ version: v, upload });
  const calls = mock.state.calls.length;
  expect(await ask(next)).toEqual({ version: v, healthy: true });
  expect(asked).toEqual(["https://next.example.com/api/health"]);
  expect(mock.state.calls.slice(calls).filter((c) => c.includes("/d1/"))).toEqual([]);
  answer = () =>
    report({ version: v, upload, ok: false, checks: { db: { ok: true }, documents: { ok: false, error: "a document didn't open" } } });
  expect(await ask(next)).toEqual({ version: v, healthy: false, health: "documents: a document didn't open" });

  // The address is down, while the Worker's health row says healthy.
  answer = () => new Response("error code: 1016", { status: 530 });
  expect(await ask(next)).toEqual({
    version: v,
    healthy: false,
    health: "https://next.example.com answered 530, and not the server's own report",
  });
  answer = () => Promise.reject(new Error("Unable to connect"));
  expect(await ask(next)).toEqual({ version: v, healthy: false, health: "https://next.example.com gave no answer: Unable to connect" });

  // Another Worker answers at the address, with another release or with the same one: the entry's Worker runs nothing
  // there, so the answer names no commit (auto-deploy deploys nothing to it).
  const other = (as: string) => ({
    version: null,
    healthy: false,
    error: `https://next.example.com answers as ${as}, and the Worker erga-next runs release ${v}, upload ${upload}: if another Worker has the address now, register the instance again (bun erga register next.example.com)`,
  });
  answer = () => report({ version: "other0000000" });
  expect(await ask(next)).toEqual(other("release other0000000"));
  answer = () => report({ version: v, upload: `${v}-1` });
  expect(await ask(next)).toEqual(other(`release ${v}, upload ${v}-1`));
  answer = () => report({ version: v });
  expect(await ask(next)).toEqual(other(`release ${v}`));

  // A sign-in answers for the address: the reader takes the health row.
  answer = () => new Response(null, { status: 302, headers: { location: "https://team.example.com/sign-in" } });
  expect(await ask(next)).toEqual({ version: v, healthy: true });
  answer = () => new Response("Forbidden", { status: 403 });
  expect(await ask(next)).toEqual({ version: v, healthy: true });
  expect(mock.state.calls.at(-1)).toMatch(/\/d1\/database\/[^/]+\/query$/);
});

test("a read of the address: the report, a sign-in in front, or why there is none", async () => {
  const says = (answer: Response | Error) =>
    publicHealth("a.example.com", () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  expect(await says(report({ version: "abc", upload: "abc-1" }))).toEqual({
    at: "report",
    ok: true,
    version: "abc",
    upload: "abc-1",
    failed: "",
  });
  // A release from before the upload's name.
  expect(await says(Response.json({ ok: true, version: "abc", checks: {} }))).toEqual({
    at: "report",
    ok: true,
    version: "abc",
    upload: null,
    failed: "",
  });
  expect(await says(new Response(null, { status: 302 }))).toEqual({ at: "gate" });
  expect(await says(new Response("<html>", { status: 200 }))).toEqual({
    at: "down",
    why: "https://a.example.com answered 200, and not the server's own report",
  });
  expect(await says(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toEqual({
    at: "down",
    why: "https://a.example.com gave no answer in 5 s",
  });
});
