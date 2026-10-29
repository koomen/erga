// The app's HTTP, in Effect. A route is an Effect that answers an
// HttpServerRequest (effect/http) with an HttpServerResponse; it reaches the
// Platform as a service (CurrentPlatform). cloudflare/index.ts turns the
// whole app into the Worker's fetch handler, and the unit tests call
// server/app.ts's `handle`, which does the same.
//
// Here too: the answers every route gives the same way (JSON that no cache
// keeps, a redirect, a plain text), a form or a query read with a Schema,
// and a web Response from code that still makes one (a Durable Object's
// answer, a WebSocket's upgrade), passed through as it is.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Platform } from "./platform.ts";

/** The Platform the app runs on (server/platform.ts), for every route. */
export class CurrentPlatform extends Context.Service<CurrentPlatform, Platform>()("erga/Platform") {}

/** What a route needs: the request, and the Platform. */
export type Needs = HttpServerRequest.HttpServerRequest | CurrentPlatform;

/** A route: its answer to the request. Its failures are typed; the app's edge answers any left with a 500. */
export type Route<E = never> = Effect.Effect<HttpServerResponse.HttpServerResponse, E, Needs>;

/** The web Request under the HttpServerRequest: the Platform's calls take it (sessionOf, assets, the objects' fetch). */
export const webRequest: Effect.Effect<Request, never, HttpServerRequest.HttpServerRequest> = Effect.map(
  Effect.service(HttpServerRequest.HttpServerRequest),
  (r) => r.source as Request
);

/** The request's URL, whole (the HttpServerRequest's own `url` is only its path). */
export const requestUrl = Effect.map(webRequest, (r) => new URL(r.url));

/** The Platform. */
export const platform = Effect.service(CurrentPlatform);

/** The header of an answer that no cache keeps. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** `body` as JSON, that no cache keeps; `headers` add to that. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...NO_STORE, ...headers } });

/** `body` as JSON, as a cache may keep it (the answers that said nothing of caching before). */
export const plainJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });

/** A redirect to `location` (302 unless said), with any more headers. */
export const redirect = (location: string, status = 302, headers: Record<string, string> = {}) =>
  HttpServerResponse.empty({ status, headers: { Location: location, ...headers } });

/** Plain text. */
export const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(body, { status, contentType: "text/plain; charset=utf-8", headers });

/** An HTML page. */
export const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(body, { status, contentType: "text/html; charset=utf-8", headers });

/** A web Response, as it is: its body, its headers, and a WebSocket's upgrade (which a copy would lose). */
export const fromWeb = (response: Response) => HttpServerResponse.raw(response);

/** An answer as a web Response (for code that reads or rewrites one: the page's corner, live.js, the security headers). */
export const toWeb = (response: HttpServerResponse.HttpServerResponse) => HttpServerResponse.toWeb(response);

/** The status of an answer. */
export const statusOf = (response: HttpServerResponse.HttpServerResponse) => response.status;

/** A body or a query that didn't decode: what was wrong with it, for a 400. */
export class BadInput extends Schema.TaggedError<BadInput>()("BadInput", { message: Schema.String }) {}

const decodeWith = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError((e) => new BadInput({ message: e.message })));

/** The request's form (application/x-www-form-urlencoded or multipart), its fields as `schema` has them. */
export const form = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  webRequest.pipe(
    Effect.flatMap((r) => Effect.tryPromise({ try: () => r.formData(), catch: () => new BadInput({ message: "The body isn't a form." }) })),
    Effect.flatMap((f) => decodeWith<S>(schema, Object.fromEntries([...f].map(([k, v]) => [k, typeof v == "string" ? v : v.name]))))
  );

/** The request's query, as `schema` has it. */
export const query = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  requestUrl.pipe(Effect.flatMap((u) => decodeWith<S>(schema, Object.fromEntries(u.searchParams))));

/** A form field or query parameter that may be missing: "" then, as `formData().get() ?? ""` gave. */
export const Field = Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")));

/** A Promise of the Platform's (its calls stay Promises): its failure is a defect, as a throw in a route was. */
export const call = <A>(f: () => PromiseLike<A>) => Effect.promise(f);

/** What most routes start with: the web Request, its URL, and the Platform. */
export const ctx = Effect.all({ request: webRequest, url: requestUrl, platform });

/** A route's answer to a web Request on a Platform: the Worker's fetch handler (cloudflare/index.ts) and the tests run routes so. */
export const respond = <E>(route: Route<E>, request: Request, p: Platform): Promise<Response> =>
  HttpEffect.toWebHandlerWith<CurrentPlatform, Needs>(Context.make(CurrentPlatform, p))(route)(request);

/** Runs an Effect of the app's on a web Request and a Platform (a test's way to call one route's part). */
export const runOn = <A, E>(effect: Effect.Effect<A, E, Needs>, request: Request, p: Platform): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      Effect.provideService(CurrentPlatform, p)
    )
  );
