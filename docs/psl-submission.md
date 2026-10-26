# Public Suffix List submission for erga-pages.dev

Each document's page runs on its own origin, `<id>-<owner>.erga-pages.dev`
(`server/documents/pages-origin.ts`). The authors of a document write its
scripts. Today `erga-pages.dev` is not on the
[Public Suffix List](https://publicsuffix.org/) (PSL). So browsers treat all
document pages as one site:

- A page can set a cookie with `Domain=erga-pages.dev`. The browser then
  sends this cookie to every other document's page, and their scripts can
  read it ("cookie tossing").
- A page can set many large cookies for `erga-pages.dev`. Then requests to
  every other document's page are too large, and the pages do not load in
  that browser until the person clears the cookies.
- Browsers share some limits and storage partitions by site.

When the domain is on the PSL, each `<id>-<owner>.erga-pages.dev` is a site
of its own, and these problems stop.

What Erga does until then:

- Erga's own code sets no cookie on the pages origin and reads none there.
  The pages origin removes the `Cookie` header before a request goes to the
  document (`pagesRoutes`; test: `tests/security-headers.test.ts`).
- The session cookie is on `erga.dev` (host-only). A page on
  `erga-pages.dev` cannot set or read it, because it is another site.

This file is the submission, ready for Pete. Nothing is submitted, and no
DNS record is changed.

## Before the submission: Pete's decisions

1. **Registration term.** The PSL needs more than two years left on each
   domain's registration when the pull request (PR) opens. On 2026-10-25:
   - `erga-pages.dev` expires on 2027-10-03.
   - `erga-pages-staging.dev` expires on 2027-10-05.

   Renew each domain for at least two more years (to 2029-10 or later), and
   turn on auto-renew.
2. **Size of the user base.** The PSL accepts private entries only for
   projects with thousands of users ("2000 - 3000 distinct users or more").
   It declines small, test or beta projects. Submit when Erga has that many
   users, or the PR will probably wait or be declined. Give the real number
   in the PR.
3. **The staging domain.** The guidelines decline "private-use, sandbox,
   test, lab, beta" entries. Only Erga's admins use `erga-pages-staging.dev`.
   The recommendation: submit `erga-pages.dev` only. Staging is for admins,
   so cookie tossing there is a small risk. The text below has the line for
   staging; remove it if you agree.
4. **The contact address.** The PSL needs a role-based email address that a
   person reads, with an answer in 30 days or less (for example
   `security@erga.dev`). Erga has no such address yet. Make it, and put it
   in place of `security@erga.dev` below if it is different.
5. **The abuse contact.** The PSL needs a page on the organization's site
   where anyone can report abuse (phishing, malware) on a subdomain. Erga
   has no such page yet. Add one (for example `https://erga.dev/abuse`, or a
   section in `SECURITY.md` that the site links to), and put its URL below.
6. **The organization.** The text below names the organization "Erga" and
   the submitter "Peter Koomen". Change them if a company owns the domains.

## The lines to add

Put this block in the PRIVATE section of `public_suffix_list.dat`, between
`===BEGIN PRIVATE DOMAINS===` and `===END PRIVATE DOMAINS===`. The section
is sorted by the name in the comment, so "Erga" goes after "encoway GmbH"
and before "EU.org". Today that is:

```
// encoway GmbH : https://www.encoway.de
// Submitted by Marcel Daus <cloudops@encoway.de>
eu.encoway.cloud

// Erga : https://erga.dev
// Submitted by Peter Koomen <security@erga.dev>
erga-pages.dev
erga-pages-staging.dev

// EU.org : https://eu.org/
// Submitted by Pierre Beyssac <hostmaster@eu.org>
eu.org
```

The two entries are sorted by the TLD and then by the next label:
`erga-pages.dev` comes before `erga-pages-staging.dev`. Use no tab and no
space at the end of a line. Check the neighbours again on the day of the PR,
because the list changes.

What the entries do (the PR asks for this):

| Name | Before | After |
| --- | --- | --- |
| `abcd1234-ada.erga-pages.dev` | site `erga-pages.dev` | site `abcd1234-ada.erga-pages.dev` |
| `efgh5678-bo.erga-pages.dev` | site `erga-pages.dev` (the same site as above) | site `efgh5678-bo.erga-pages.dev` |
| a cookie with `Domain=erga-pages.dev` | sent to every document's page | refused by the browser |

Erga gives each document one name, one label under the domain. No other
level is used, so no wildcard (`*.`) or exception (`!`) rule is necessary.

## The DNS records

The PSL checks each name with a TXT record at `_psl.<name>` that holds the
PR's URL. Add the records after you open the PR, when you know its number
(`NNNN` below). Both zones are on Cloudflare (`will.ns.cloudflare.com`,
`monroe.ns.cloudflare.com`).

| Zone | Type | Name | Content |
| --- | --- | --- | --- |
| `erga-pages.dev` | TXT | `_psl` | `https://github.com/publicsuffix/list/pull/NNNN` |
| `erga-pages-staging.dev` | TXT | `_psl` | `https://github.com/publicsuffix/list/pull/NNNN` |

Keep the records after the PR merges: the PSL may remove an entry whose
record is gone.

Erga's document pages use the wildcard `*.erga-pages.dev`. A `_psl` name is
not a document's name (a document's label is `<id>-<owner>`), so the TXT
record does not change how a page loads. Check it after you add it:

```
dig +short TXT _psl.erga-pages.dev
dig +short TXT _psl.erga-pages-staging.dev
```

Each command must show `"https://github.com/publicsuffix/list/pull/NNNN"`.

## The steps

1. Make Pete's decisions above (renewal, user count, staging, contact,
   abuse page).
2. Fork https://github.com/publicsuffix/list and clone the fork.
3. Add the block above to `public_suffix_list.dat`, at its sorted place.
4. Run `make test` in the clone. Fix any error that it shows.
5. Commit, push to the fork, and open a PR. Paste the PR text below as the
   description, and fill in `NNNN`, the user count and the abuse URL.
6. Add the two TXT records in Cloudflare, with the PR's URL.
7. Run the two `dig` commands. Each must show the PR's URL.
8. Answer the volunteers' questions in the PR and by email. There is no time
   limit; approval takes weeks or months.
9. After the merge, browsers take months to get the new list. Keep the
   cookie rules in Erga's code (above) after that, too.

## The PR text

Title: `Add erga-pages.dev (Erga)`

The text follows the PSL's PR template
(`.github/pull_request_template.md`). Paste it in place of the template, and
keep the `FILL IN` comment lines the template asks for.

~~~~markdown
# Public Suffix List (PSL) Submission

### Checklist of required steps

* [x] Description of Organization
* [x] Robust Reason for PSL Inclusion
* [x] DNS verification via dig

* [x] Each domain listed in the PRIVATE section has and shall maintain at least two years remaining on registration, and we shall keep the `_psl` TXT record in place in the respective zone(s).

__Submitter affirms the following:__

 * [x] We are listing *any* third-party limits that we seek to work around in our rationale such as those between iOS 14.5+ and Facebook (see [Issue #1245](https://github.com/publicsuffix/list/issues/1245) as a well-documented example)
 <!-- FILL IN (CAN BE EMPTY): Third-party limits worked around (keep this line and its END FILL IN) -->
 <!-- END FILL IN -->

 * [x] This request was _not_ submitted with the objective of working around other third-party limits.

 * [x] The submitter acknowledges that it is their responsibility to maintain the domains within their section. This includes removing names which are no longer used, retaining the _psl DNS entry, and responding to e-mails to the supplied address. Failure to maintain entries may result in removal of individual entries or the entire section.

 * [x] The [Guidelines](https://github.com/publicsuffix/list/wiki/Guidelines) were carefully _read_ and _understood_, and this request conforms to them.
 * [x] The submission follows the [Guidelines](https://github.com/publicsuffix/list/wiki/Format) on formatting and sorting.

 * [x] A role-based email address has been used and this inbox is actively monitored with a response time of no more than 30 days.

**Abuse Contact:**

* [x] Abuse contact information (email or web form) is available and easily accessible.

  URL where abuse contact or abuse reporting form can be found:
  <!-- FILL IN: Abuse contact URL (keep this line and its END FILL IN) -->
  https://erga.dev/abuse
  <!-- END FILL IN -->

---

 * [x] *Yes, I understand*. I could break my organization's website cookies and cause other issues, and the rollback timing is acceptable. *Proceed anyway*.

---

## Description of Organization
<!-- FILL IN: Description of Organization (keep this line and its END FILL IN) -->
Erga is an open-source (MIT) editor for web documents: HTML pages that people write and edit together, with an AI agent in the editor. It runs on Cloudflare Workers; the hosted service is at erga.dev, and anyone can run their own copy. The editor's own site is erga.dev. Each document's page runs on a separate origin under erga-pages.dev, because a document's HTML and scripts are written by its authors, and the people who open it must not run that code as the editor's site or as another document.

I am Peter Koomen, Erga's author and the operator of erga.dev, erga-pages.dev and erga-pages-staging.dev. I am submitting this as the owner of these domains.
<!-- END FILL IN -->

**Organization Website:**
<!-- FILL IN: Organization Website (keep this line and its END FILL IN) -->
https://erga.dev
<!-- END FILL IN -->

## Reason for PSL Inclusion
<!-- FILL IN: Reason for PSL Inclusion (keep this line and its END FILL IN) -->
Each document on Erga gets its own name, `<id>-<owner>.erga-pages.dev` (for example `abcd1234-ada.erga-pages.dev`), and its page runs there. The documents belong to many different people who do not trust each other, and each document's scripts are its authors' own code. Erga uses one origin per document so that one document's scripts can't read or change another's.

Without a PSL entry, browsers treat all of these names as one site, `erga-pages.dev`. So one document's page can set a cookie with `Domain=erga-pages.dev` that the browser sends to every other document's page and that their scripts can read (cookie tossing), or set enough cookies to stop other documents' pages from loading in that browser. Browsers also share some storage partitions and limits by site. With the entry, each document's name is a site of its own, and the browser refuses a cookie for the parent domain. This is the reason for the request: cookie and site isolation between documents of different owners. It is not to work around any third-party limit.

Expected result:
- `abcd1234-ada.erga-pages.dev` and `efgh5678-bo.erga-pages.dev` are different sites (today they are one site, `erga-pages.dev`).
- A page at `abcd1234-ada.erga-pages.dev` can't set a cookie with `Domain=erga-pages.dev`.
- Each document has one label under the domain, so no wildcard or exception rule is needed.

`erga-pages-staging.dev` is the same service's pre-release copy, with the same layout (`<id>-<owner>.erga-pages-staging.dev`), where Erga's operators test each release on real documents before it goes to erga-pages.dev.

Erga's own site (erga.dev) is not in this request, and erga.dev's session cookie is host-only, so the entry changes no cookie of erga.dev.

Both domains are registered until at least <DATE AFTER RENEWAL>, more than two years from today, with auto-renew on, and we will keep more than one year of registration on them for as long as they are listed. There are no earlier issues or PRs for these domains.
<!-- END FILL IN -->

**Number of THOUSANDS of distinct users this request is being made to serve:**
<!-- FILL IN: Number of thousands of distinct users (keep this line and its END FILL IN) -->
<N> thousand (<actual count / estimate>, as of <date>)
<!-- END FILL IN -->

## DNS Verification
<!-- FILL IN: DNS verification records (keep this line and its END FILL IN) -->
```
dig +short TXT _psl.erga-pages.dev
"https://github.com/publicsuffix/list/pull/NNNN"
```

```
dig +short TXT _psl.erga-pages-staging.dev
"https://github.com/publicsuffix/list/pull/NNNN"
```
<!-- END FILL IN -->
~~~~
