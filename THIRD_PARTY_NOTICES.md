# Third-party notices

Erga is under the MIT license (LICENSE). It ships, or bundles, the work of
others under their own licenses. This file lists them.

## Fonts

| Font | Files | License | Notice |
| --- | --- | --- | --- |
| Inter | `client/fonts/inter-*.woff2`, `e2e/fixtures/multi/fonts/field.woff2` | SIL OFL 1.1 | `client/fonts/Inter-LICENSE.txt` |
| Alfa Slab One, Courier Prime, Instrument Sans, JetBrains Mono, Literata, Oswald | `assets/landing/fonts/*.woff2` | SIL OFL 1.1 | `assets/landing/fonts/LICENSE.txt` |
| Special Elite | `assets/logo/SpecialElite-Regular.ttf` (`assets/logo/make.ts` draws the logo with it) | Apache 2.0 | `assets/logo/SpecialElite-LICENSE.txt` |

The copyright line of each font comes from the font's own name table.

## Packages

The direct dependencies (`package.json`), and their licenses:

| Package | License | Shipped |
| --- | --- | --- |
| `@codemirror/commands`, `@codemirror/lang-html`, `@codemirror/language`, `@codemirror/state`, `@codemirror/view`, `@lezer/highlight` | MIT | yes |
| `effect`, `@effect/ai-anthropic` | MIT | yes |
| `@earendil-works/pi-ai` (with `openai` and `@google/genai`, Apache 2.0, which it bundles) | MIT | yes |
| `diff` | BSD-3-Clause | yes |
| `lib0`, `yjs`, `y-protocols`, `y-websocket` | MIT | yes |
| `pdf-lib`, `unpdf` | MIT | yes |
| `@cloudflare/puppeteer` | Apache 2.0 | yes |
| `@cloudflare/vite-plugin`, `vite`, `@types/bun`, `@types/node` | MIT | no (development) |
| `cf` | MIT or Apache 2.0 | no (development) |
| `@e2e-dev/web`, `e2e`, `playwright-core`, `typescript` | Apache 2.0 | no (development) |

All the installed packages (2026-10-25, after `bun install`), by license.
"Production" is every package that a direct dependency needs, so it is the
most that the build can bundle:

| License | Production | Development only |
| --- | --- | --- |
| MIT | 83 | 65 |
| Apache 2.0 | 36 | 13 |
| BSD-3-Clause | 13 | 1 |
| BSD-2-Clause | 4 | 0 |
| ISC | 2 | 2 |
| MIT and Zlib (`pako`) | 1 | 0 |
| 0BSD (`tslib`) | 1 | 0 |
| MIT or Apache 2.0 | 0 | 3 |
| MPL 2.0 (`lightningcss`) | 0 | 2 |
| LGPL 3.0 or later (`@img/sharp-libvips-*`) | 0 | 1 |
| CC0 1.0 (`@speed-highlight/core`) | 0 | 1 |
| AFL 2.1 or BSD-3-Clause (`json-schema`) | 0 | 1 |

Notes:

- No copyleft code is in the production set. `@img/sharp-libvips` (LGPL) and
  `lightningcss` (MPL) are build tools of Vite and Wrangler. Erga does not ship them.
- `ai-docs` has no license field. It is not a dependency: it is a folder of
  examples inside the `effect` package (`node_modules/effect/ai-docs`), under
  Effect's MIT license. Erga does not import it, and the build does not bundle it.

- The counts above are from before `@earendil-works/pi-ai` (2026-11-01). It
  adds about 80 packages, MIT and Apache 2.0 for the most part. Of them the build
  bundles only the OpenAI and Google SDKs: Erga does not import its other providers
  (the AWS SDK of Bedrock, Mistral's).

To list the licenses again, read the `license` field of each
`node_modules/**/package.json`.
