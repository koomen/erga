// A wait for a state, in place of a fixed pause: a pause is slow when the code is fast, and too short when the machine
// is busy (tests/test-habits.test.ts).

/** Waits until `ok()` gives something truthy, and returns it; fails after `ms` (under a test's own 5 seconds). */
export async function until<T>(ok: () => T | Promise<T>, ms = 4_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let v = await ok();
  for (; !v && Date.now() < end; v = await ok()) await new Promise((r) => setTimeout(r, 2));
  if (!v) throw new Error(`not within ${ms} ms: ${ok}`);
  return v;
}
