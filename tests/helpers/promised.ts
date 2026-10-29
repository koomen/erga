// An object whose methods answer Effects, with each Effect run to a Promise, as
// the Durable Object runs a Document's (cloudflare/objects/document.ts): what the
// tests await. Other methods and fields are as they are.

import * as Effect from "effect/Effect";

export type Promised<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, never> ? (...args: A) => Promise<R> : T[K];
};

export function promised<T extends object>(target: T): Promised<T> & { readonly self: T } {
  return new Proxy(target, {
    get(t, key) {
      if (key == "self") return t;
      const v = Reflect.get(t, key, t);
      if (typeof v != "function") return v;
      return (...args: unknown[]) => {
        const r = v.apply(t, args);
        return Effect.isEffect(r) ? Effect.runPromise(r as Effect.Effect<unknown, unknown>) : r;
      };
    },
  }) as Promised<T> & { readonly self: T };
}
