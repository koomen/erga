// The sign-in buttons, one for each provider that is on, as each provider's brand rules say (Google's white with its G;
// GitHub's dark with its mark): on the sign-in page (server/identity/sign-in.ts) and in the sign-in dialog
// (client/common/sign-in-dialog.ts). Each goes to that provider's sign-in, and back to `next`.

import { esc } from "./html";

/**
 * Each way to sign in, as the app names it. The app reads this table by a provider's id and never asks which provider it
 * is: an OAuth provider (server/identity/providers.ts), or the proxy in front of the server (server/identity/proxy.ts).
 * `name`: its name in a list; `label`: what its sign-in is called, in a sentence to the person who signs in.
 * `handle`: what an admin adds a person by before their first sign-in: a login (its account is looked up at once), or an
 * email address (the first sign-in with that verified address matches). `profile`: a profile's address, pasted for a
 * login. `groups`: the kind of access rule its groups
 * match, and what the page says of them to a person no rule lets in.
 */
export const SIGN_IN_PROVIDERS: Record<
  string,
  {
    name: string;
    label: string;
    handle: "login" | "email";
    profile?: RegExp;
    groups?: { kind: string; said: (groups: string[]) => string };
  }
> = {
  github: {
    name: "GitHub",
    label: "GitHub",
    handle: "login",
    profile: /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/?$/,
    groups: {
      kind: "github_org",
      said: (orgs) =>
        `GitHub says this account is an active member of ${orgs.length ? orgs.join(", ") : "no organization Erga can see"}. If you are a member, the organization may not let Erga see it yet: an owner of the organization approves Erga on GitHub.`,
    },
  },
  google: {
    name: "Google",
    label: "Google",
    handle: "email",
    groups: {
      kind: "workspace",
      said: (workspaces) =>
        workspaces.length
          ? `Google says this account is in the Workspace ${workspaces.join(", ")}.`
          : "This is a personal Google account: it's in no Google Workspace organization.",
    },
  },
  proxy: { name: "Proxy", label: "your company's sign-in", handle: "email" },
};

/** What a provider's sign-in is called, in a sentence to the person who signs in. */
export const providerLabel = (provider: string) => SIGN_IN_PROVIDERS[provider]?.label ?? provider;
/** A provider's name, in a list or on an admin page. */
export const providerName = (provider: string) => SIGN_IN_PROVIDERS[provider]?.name ?? provider;

/** A way to sign in that is on: a provider's id (its sign-in is at /auth/<id>) and its name. */
export interface SignInChoice {
  id: string;
  label: string;
}

/** The buttons, each to the provider's sign-in and back to `next`; `base`: where Erga's paths are ("/_erga" on the homepage's own domain). */
export const providerButtons = (choices: SignInChoice[], next: string, base = "") =>
  choices
    .map(
      (c) =>
        `<a class="provider ${esc(c.id)}" href="${base}/auth/${esc(c.id)}?next=${encodeURIComponent(next)}">${LOGOS[c.id] ?? ""}<span>Continue with ${esc(c.label)}</span></a>`
    )
    .join("");

/** The buttons' style. */
export const PROVIDER_CSS = `
.providers { display: flex; flex-direction: column; gap: 10px; max-width: 320px; margin-top: 6px; }
.provider { box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 10px; height: 40px; padding: 0 16px; border: 1px solid; border-radius: 8px;
  font: 500 14px/1 "Roboto", var(--font-text, ui-sans-serif, system-ui, sans-serif); text-decoration: none; white-space: nowrap; transition: background-color 150ms ease; }
.provider svg { flex: none; width: 18px; height: 18px; }
.provider:focus-visible { outline: 2px solid var(--caret, #3b7cf0); outline-offset: 2px; }
.provider.google { color: #1f1f1f; background: #fff; border-color: #747775; }
.provider.google:hover { background: #f2f2f2; }
.provider { color: var(--fg-strong, #1f1f1f); background: transparent; border-color: #747775; }
.provider.github { color: #fff; background: #24292f; border-color: #24292f; }
.provider.github:hover { background: #32383f; }
@media (prefers-color-scheme: dark) {
  .provider.google { color: #e3e3e3; background: #131314; border-color: #8e918f; }
  .provider.google:hover { background: #222224; }
  .provider.github { border-color: #6e7681; }
}`;

/** Each provider's logo, for its button: GitHub's mark (in the button's text colour) and Google's G, in its four colours. */
const LOGOS: Record<string, string> = {
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`,
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
};
