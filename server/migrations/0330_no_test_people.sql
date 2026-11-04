-- Erga no longer has test people (the test token, /auth/test). Their tokens go: nothing reads `test_by` now, and such
-- a token would act as an account named test-..., which nobody may take (identities.ts). The column stays.
DELETE FROM agent_tokens WHERE test_by IS NOT NULL;
