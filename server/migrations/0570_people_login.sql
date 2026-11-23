-- A person who keeps an account that is there already (server/directory/people.ts, `login`). A server that moves from
-- GitHub or Google sign-in to the organization's single sign-on keeps its accounts, but a sign-in there is another
-- identity: the provider is another one, and so is its id for the person. `bun erga setup` writes one row for each
-- account, with the person's address at the organization's sign-in (deploy/own/first.ts). Their first sign-in with
-- that address, verified, links the new identity to the account `login`, and the row goes (server/identity/accounts.ts,
-- resolve). NULL: a person an admin added, who gets a new account.
ALTER TABLE people ADD COLUMN login TEXT;
