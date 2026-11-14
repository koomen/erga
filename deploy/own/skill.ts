// `bun erga setup skill`: the manual for a coding agent that sets up an Erga instance for its person. The command does
// the work (deploy/own/cli.ts); the agent runs it, and passes each question and answer between the person and it.

export const SETUP_SKILL = `# Set up a new Erga instance

A new Erga runs on the person's own Cloudflare or AWS account, at an
address on their own domain. One command does all the work:

    bun erga setup <host>

<host> is the new server's address, e.g. erga.example.com. Run it from the
clone's folder, with a timeout of 10 minutes. It opens the setup page in
the person's browser, and then goes on from where the setup is. Each run
ends in one of these ways:

- ASK: a question for the person. Ask it in exactly those words, with the
  choices as numbered. Then run the THEN line that fits the answer
  (bun erga setup <host> set key=value). It prints the next question, or
  tells you to run bun erga setup <host> again.
- WAIT: a step that only the person can do, on the setup page or in a
  browser tab that opened. Tell the person what the line says. The
  command waits and goes on by itself when the step is done: the person
  never tells you "done". If it ends with "still open", run it again.
- FAIL: it says what is wrong, and what to do. Never guess past it.
- DONE: tell the person what the line says.

The person needs: a Cloudflare account with their domain on it (the
Workers Paid plan), or an AWS account with the domain in Route 53 and the
AWS CLI; a GitHub account; Bun 1.4 or newer; and git.

## The rules

- You make nothing yourself: no resource, no file, no token. The command
  makes everything, after the person's yes to the plan.
- A secret never goes into the chat, a command or a file. The person types
  it on the setup page, and only there. You never open, read or repeat a
  link from the setup page.
- Ask the person only what the command prints. Decide nothing for them.
- bun erga setup <host> remove --yes deletes the server with all its
  documents: only when the person asks for it, in those words.
- A staging instance of a registered instance on Cloudflare:
  bun erga setup <staging host> --staging-of <host>. It runs on a copy of
  its primary's data, for admins only.
- Bun installs into ~/.bun/bin, which a new shell may not have on its PATH.

## When it fails

- "isn't on a domain of this account": the person adds the domain, or
  gives another address (bun erga setup <other host>).
- "is in use": the person decides.
- "Tracked files have changes": commit or stash them; a deploy builds a commit.
- A step that failed is safe to run again: bun erga setup <host>.
- A bad deploy later: bun erga rollback <host> puts back the version before.
`;
