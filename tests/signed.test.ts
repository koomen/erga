// The one helper that signs every cookie, token and key (server/signed.ts): a sealed string opens only for its own
// purpose, with its own secret, in its shape, and before it expires. An agent token and an OAuth client id keep the
// strings they always had.

import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as Schema from "effect/Schema";
import { clientIdFor, clientOf } from "../server/identity/oauth.ts";
import { mac, signed } from "../server/signed.ts";

const Pass = Schema.Struct({ login: Schema.String });
const pass = signed("home-pass", Pass, 60);
const T = 1_800_000_000_000;

test("a sealed value opens with the same secret and purpose, until it expires", async () => {
  const text = await pass.seal("secret", { login: "ada" }, { now: T });
  expect(await pass.open("secret", text, T + 59_000)).toEqual({ login: "ada" });
  expect(await pass.open("secret", text, T + 60_000)).toBeNull();
  expect(await pass.read("secret", text, T + 60_000)).toEqual({ value: { login: "ada" }, expired: true });
  expect(await pass.open("another", text, T)).toBeNull();
  expect(await pass.open("secret", null, T)).toBeNull();
  expect(await pass.open("secret", "", T)).toBeNull();
});

test("a string sealed for one purpose never opens as another, and a changed one never opens", async () => {
  const visitor = signed("home-visitor", Pass, 60);
  const text = await pass.seal("secret", { login: "ada" }, { now: T });
  expect(await visitor.open("secret", text, T)).toBeNull();
  const [claims, sig] = text.split(".");
  const forged = Buffer.from(JSON.stringify({ v: { login: "root" }, e: T / 1000 + 60 })).toString("base64url");
  expect(await pass.open("secret", `${forged}.${sig}`, T)).toBeNull();
  expect(await pass.open("secret", `${claims}.${sig}x`, T)).toBeNull();
  expect(await pass.open("secret", `${claims}.${sig}.more`, T)).toBeNull();
});

test("a value of another shape doesn't open, and a kind that expires refuses a string with no expiry", async () => {
  const loose = signed("home-pass", Schema.Struct({ login: Schema.Number }), 60);
  expect(await pass.open("secret", await loose.seal("secret", { login: 7 }, { now: T }), T)).toBeNull();
  const forever = signed("home-pass", Pass, null);
  const text = await forever.seal("secret", { login: "ada" });
  expect(await forever.open("secret", text, T * 2)).toEqual({ login: "ada" });
  expect(await pass.open("secret", text, T)).toBeNull();
});

test("`until` sets the expiry itself: the same string for the same expiry", async () => {
  const a = await pass.seal("secret", { login: "ada" }, { now: T, until: 1_800_086_400 });
  const b = await pass.seal("secret", { login: "ada" }, { now: T + 5000, until: 1_800_086_400 });
  expect(a).toBe(b);
});

test("mac is HMAC-SHA256 in base64url: an agent token's and a client id's strings stay as they were", async () => {
  expect(await mac("erga-agent-token:secret", "tok_1")).toBe(
    createHmac("sha256", "erga-agent-token:secret").update("tok_1").digest("base64url")
  );
  const id = await clientIdFor("secret", { name: "App", redirectUris: ["http://localhost:1/cb"] });
  const value = Buffer.from(JSON.stringify({ n: "App", r: ["http://localhost:1/cb"] })).toString("base64url");
  expect(id).toBe(`${value}.${createHmac("sha256", "secret:oauth-client").update(value).digest("base64url")}`);
  expect(await clientOf("secret", id)).toEqual({ name: "App", redirectUris: ["http://localhost:1/cb"] });
  expect(await clientOf("other", id)).toBeNull();
});
