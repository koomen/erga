// A note for the next page. A form's POST never answers with a page: it answers 303 See Other to a GET page, so Back
// and Reload never send the form again. What that page shows of the POST (an error, which token was just made) goes
// along in a cookie: signed, HttpOnly, for a minute, and read once (the page that reads it clears it). Never a
// secret.

import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HttpServerResponse } from "effect/http";
import type { Platform } from "../platform.ts";
import { call, redirect } from "../http.ts";
import { cookies, withCookie } from "./cookies.ts";
import { sign, unsign } from "./session.ts";

const FLASH = "erga_flash";
const SECONDS = 60;

/** A note's fields: plain strings, which the page escapes. */
const Note = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
export type Note = Record<string, string>;

/** 303 See Other to `location`, with `note` for the page there. */
export const seeOther = (platform: Platform, request: Request, location: string, note: Note) =>
  Effect.map(
    call(() => sign(platform.secret, `flash:${Base64Url.encode(JSON.stringify(note))}`)),
    (value) => withCookie(redirect(location, 303, { "Cache-Control": "no-store" }), request, FLASH, value, SECONDS)
  );

/** The note a POST left for this page, if any. */
export async function noteOf(platform: Platform, request: Request): Promise<Note | null> {
  const raw = cookies(request).get(FLASH);
  const value = raw && (await unsign(platform.secret, raw));
  if (!value?.startsWith("flash:")) return null;
  const json = Base64Url.decodeString(value.slice("flash:".length));
  return Result.isSuccess(json) ? Option.getOrNull(Schema.decodeUnknownOption(Note)(json.success)) : null;
}

/** The page that read a note, which clears it: Back, Reload and the history never show it again. */
export const readOnce = (response: HttpServerResponse.HttpServerResponse, request: Request) =>
  cookies(request).has(FLASH) ? withCookie(response, request, FLASH, "", 0) : response;
