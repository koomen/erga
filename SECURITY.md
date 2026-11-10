# Security

## Report a vulnerability

Do not open a public issue for a vulnerability. Report it privately:

1. Open the **Security** tab of this repository on GitHub.
2. Click **Report a vulnerability**, and fill in the form.

Tell us what an attacker can do, and the steps that show it. We reply
as soon as we can, and we tell you when the fix is live.

## What we support

We fix the current `main` branch, and erga.dev, which runs it. We do not
fix old releases: a self-hosted deployment gets a fix when it updates.

## What is in scope

Erga runs pages that people and agents write. A page is not trusted. These
are the boundaries that Erga must keep, and a way past one is a
vulnerability:

- A document's page runs on its own pages origin, apart from the app's
  origin. A page must not reach the app's cookies, another document, or
  the editor's privileges.
- A person reaches a document only with the access its owner gave.
- An embedded agent acts only on what its person asks. Text that it finds
  in a page or a tool result must not make it act.
- The server never sends a stored secret (an API key, a token) to a browser
  or to a model.

`tests/frame-security.test.ts` and `e2e/security/boundaries.e2e.ts` test these
boundaries with a hostile page.
