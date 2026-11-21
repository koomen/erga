// Before the unit tests (bunfig.toml): a unit test asks no server outside this machine. A request to one gets no
// answer here, as with no network, and the test that made it fails at its end, with the address.
//
// Trap: code that asks a provider (GitHub, Google, a model) takes the answer's delay and the provider's limits into the
// test. tests/auth.test.ts asked github.com two times in one test: 0.3 s on a desk, over the test's 5 s on GitHub's
// runner. Give the code a fake of the provider (fakeGithub in tests/auth.test.ts), on an origin of the test's own.
import { afterEach } from "bun:test";

const real = globalThis.fetch;
const HERE = /^(127\.0\.0\.1|localhost|\[::1\]|.+\.localhost)$/;
let asked: string[] = [];

globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  if (!/^https?:$/.test(url.protocol) || HERE.test(url.hostname)) return real(input, init);
  asked.push(url.origin + url.pathname);
  return Promise.reject(new TypeError(`no network in a unit test: ${url.origin}`));
}, real) as typeof fetch;

afterEach(() => {
  const outside = asked;
  asked = [];
  if (outside.length)
    throw new Error(
      `This test asked ${outside.join(", ")}. A unit test asks no server outside this machine: give the code a fake (tests/helpers/no-network.ts).`
    );
});
