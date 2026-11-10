// A note for the next page. A form's POST never answers with a page: it answers 303 See Other to a GET page, so Back
// and Reload never send the form again. What that page shows of the POST (an error, which token was just made) goes
// along in a cookie: signed, HttpOnly, for a minute, and read once (the page that reads it clears it). Never a
// secret.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpServerResponse } from "effect/http";
import type { Platform } from "../platform.ts";
import { call, redirect } from "../http.ts";
import { cookies, withCookie } from "./cookies.ts";
import { signed } from "../signed.ts";

const FLASH = "erga_flash";
const SECONDS = 60;

/** A note's fields: plain strings, which the page escapes. Signed, for a minute (server/signed.ts). */
const Flash = signed("flash", Schema.Record(Schema.String, Schema.String), SECONDS);
export type Note = Record<string, string>;

/** 303 See Other to `location`, with `note` for the page there. */
export const seeOther = (platform: Platform, request: Request, location: string, note: Note) =>
  Effect.map(
    call(() => Flash.seal(platform.secret, note)),
    (value) => withCookie(redirect(location, 303, { "Cache-Control": "no-store" }), request, FLASH, value, SECONDS)
  );

/** The note a POST left for this page, if any. */
export function noteOf(platform: Platform, request: Request): Promise<Note | null> {
  return Flash.open(platform.secret, cookies(request).get(FLASH));
}

/** The page that read a note, which clears it: Back, Reload and the history never show it again. */
export const readOnce = (response: HttpServerResponse.HttpServerResponse, request: Request) =>
  cookies(request).has(FLASH) ? withCookie(response, request, FLASH, "", 0) : response;
