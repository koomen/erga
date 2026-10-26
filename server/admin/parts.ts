// What two or more admin pages show alike: a setting's value, a time, a person's picture.

import { esc } from "../../shared/html.ts";
import { colorFor } from "../../document/content.ts";
import { SYSTEM } from "../../shared/attribution.ts";

export const shown = (v: unknown, kind?: string) =>
  v === null
    ? kind == "document"
      ? "none"
      : "never"
    : typeof v == "boolean"
      ? v
        ? "on"
        : "off"
      : typeof v == "string"
        ? `“${v}”`
        : Array.isArray(v) && kind == "users"
          ? v.length
            ? v.join(", ")
            : "nobody"
          : JSON.stringify(v);

/** When a setting was last set, as the admin page says it: "2026-10-05 14:03 UTC". */
export const setAt = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A person's picture (shared/avatars.ts), on their initial in their colour (shown if they have none, or it doesn't load); the system has a dot. */
export function avatarHtml(by: string, avatar?: string | null): string {
  if (!by || by == SYSTEM) return `<span class="avatar system" aria-hidden="true">•</span>`;
  const login = by.toLowerCase();
  const pic = avatar
    ? `<img src="${esc(avatar)}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer" data-erga-fallback>`
    : "";
  return `<span class="avatar" style="--c: ${colorFor(login)}" aria-hidden="true">${esc(login[0]?.toUpperCase() ?? "?")}${pic}</span>`;
}
