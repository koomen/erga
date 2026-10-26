// A person's picture: the one place that makes and checks an avatar's address, for the server and the editor.
//
// A GitHub account's picture is GitHub's, found by its numeric id (/u/<id>), never by a login: a login can change hands,
// and an Erga username is not a GitHub login. A Google account's is the `picture` Google gave at its last sign-in, on
// googleusercontent.com. Sign-in keeps it (users.avatar, server/directory/identities.ts). Any other account, and one
// with no picture, has none: the page shows the person's initial on their colour.

const GITHUB = "https://avatars.githubusercontent.com";
/** The size the pages show a picture at, doubled for sharp screens. */
const SIZE = 64;

/** A GitHub account's picture, by its numeric id; null for anything else. */
export function githubAvatar(id: string | number): string | null {
  const s = String(id);
  return /^[1-9][0-9]{0,15}$/.test(s) ? `${GITHUB}/u/${s}?s=${SIZE}` : null;
}

/** Google's picture for an account (its `picture` claim), if it is one of Google's: at our size. */
export function googleAvatar(picture: string | null | undefined): string | null {
  const url = parse(picture);
  if (!url || !isGoogle(url)) return null;
  // Google's size goes at the end, after "=" (lh3.googleusercontent.com/a/<id>=s96-c).
  url.pathname = url.pathname.replace(/=s\d+(-c)?$/, "") + `=s${SIZE}-c`;
  return url.toString();
}

/** The picture of a provider's account at its sign-in: GitHub's by its id, Google's from its claim. */
export function avatarFor(v: { provider: string; subject: string; picture?: string | null }): string | null {
  if (v.provider == "github") return githubAvatar(v.subject);
  if (v.provider == "google") return googleAvatar(v.picture);
  return null;
}

/**
 * An address a page may show as a picture: GitHub's by id, or Google's; null for anything else. The editor asks it
 * of every participant's picture, since anyone in a room can put anything in their presence.
 */
export function safeAvatar(avatar: string | null | undefined): string | null {
  const url = parse(avatar);
  if (!url) return null;
  if (url.origin == GITHUB) return /^\/u\/[1-9][0-9]*$/.test(url.pathname) ? url.toString() : null;
  return isGoogle(url) ? url.toString() : null;
}

const parse = (s: string | null | undefined) => {
  try {
    return s ? new URL(s) : null;
  } catch {
    return null;
  }
};
const isGoogle = (url: URL) =>
  url.protocol == "https:" && !url.port && (url.hostname == "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"));
