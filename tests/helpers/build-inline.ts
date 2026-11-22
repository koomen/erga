// Before the unit tests (bunfig.toml): the inline code, built from client/inline/ as it is now. The server imports it.
// The suite builds it one time before the tests (ERGA_BUILT, e2e/run.ts): then no file builds it again (0.17 s for
// each of 231 files).
export {};

if (!process.env.ERGA_BUILT) await (await import("../../client/build.ts")).writeInline();
