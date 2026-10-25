-- Each account's verified email addresses, as its identities' providers
-- gave them at their last sign-in (server/directory/identities.ts): one row
-- for each address of each identity, by the identity (provider, subject),
-- so a sign-in replaces only its own provider's, and unlinking an identity
-- takes its addresses away. Only verified addresses are kept, and never
-- GitHub's noreply ones (<id>+<login>@users.noreply.github.com).
--
-- A new identity's first sign-in links to the one account whose address it
-- shares (the rules in server/identity/accounts.ts). After that, the identity
-- finds its account by its subject id, never by an address: a changed
-- address never moves a sign-in to another account. The access rules on
-- domains read these addresses too. A Worker from before this never reads
-- the table.
CREATE TABLE IF NOT EXISTS emails (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  login TEXT NOT NULL,
  seen INTEGER NOT NULL,
  PRIMARY KEY (provider, subject, email)
);
CREATE INDEX IF NOT EXISTS emails_by_email ON emails (email);
CREATE INDEX IF NOT EXISTS emails_by_login ON emails (login);
