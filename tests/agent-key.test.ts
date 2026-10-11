// The agent's key in local development: a real one in .dev.vars wins, else the environment's.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isRealKey, localAgentKey } from "../dev/agent-key";

const withDevVars = (text: string | null, f: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "erga-key-"));
  if (text != null) writeFileSync(join(dir, ".dev.vars"), text);
  try { f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const REAL = "sk-ant-api03-file-key-0123456789", ENV = "sk-ant-api03-env-key-0123456789";

test("placeholders aren't keys", () => {
  for (const k of [undefined, "", "xxxxxx", "sk-", "sk-short", "your-key-here-not-a-key-at-all"]) expect(isRealKey(k)).toBe(false);
  expect(isRealKey(REAL)).toBe(true);
});

test("a real key in .dev.vars wins over the environment's", () => {
  withDevVars(`DEV_LOGIN=me\nANTHROPIC_API_KEY=${REAL}\n`, (d) => expect(localAgentKey(d, { ANTHROPIC_API_KEY: ENV })).toBe(REAL));
  withDevVars(`ANTHROPIC_API_KEY="${REAL}"\n`, (d) => expect(localAgentKey(d, {})).toBe(REAL));
});

test("a placeholder or no .dev.vars: the environment's key", () => {
  withDevVars(`ANTHROPIC_API_KEY=abcdef\n`, (d) => expect(localAgentKey(d, { ANTHROPIC_API_KEY: ENV })).toBe(ENV));
  withDevVars(`ANTHROPIC_API_KEY=\n`, (d) => expect(localAgentKey(d, { ANTHROPIC_API_KEY: ENV })).toBe(ENV));
  withDevVars(null, (d) => expect(localAgentKey(d, { ANTHROPIC_API_KEY: ENV })).toBe(ENV));
});

test("neither real: none", () => {
  withDevVars(`ANTHROPIC_API_KEY=abcdef\n`, (d) => expect(localAgentKey(d, { ANTHROPIC_API_KEY: "placeholder" })).toBe(""));
  withDevVars(null, (d) => expect(localAgentKey(d, {})).toBe(""));
});
