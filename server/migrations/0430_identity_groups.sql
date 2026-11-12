-- What the access rules read of a sign-in is a list of groups, the same for every provider (server/directory/access.ts,
-- groupOf: a rule's kind and its value). identities.groups: the groups the provider said the account is in at its
-- last sign-in, a JSON list; NULL: none known. It takes the place of `hd` (a Google Workspace) and `orgs` (GitHub
-- organizations), which stay in the table (a migration only adds) and which nothing reads now.
ALTER TABLE identities ADD COLUMN groups TEXT;

UPDATE identities SET groups = (
  SELECT json_group_array(g) FROM (
    SELECT 'workspace:' || lower(identities.hd) AS g WHERE identities.hd IS NOT NULL AND identities.hd != ''
    UNION ALL
    SELECT 'github_org:' || lower(j.value) FROM json_each(CASE WHEN json_valid(identities.orgs) THEN identities.orgs ELSE '[]' END) j
  )
) WHERE hd IS NOT NULL OR orgs IS NOT NULL;

-- The sign-in in front of the server is the provider 'proxy' (it was 'front'): server/identity/proxy.ts.
UPDATE identities SET provider = 'proxy' WHERE provider = 'front';
UPDATE emails SET provider = 'proxy' WHERE provider = 'front';
