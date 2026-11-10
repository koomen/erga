-- Each person's sign-in number (server/identity/session.ts): a session cookie carries the number it was made with, and
-- sign-out raises the person's number, so every cookie made before it stops, on every device. A cookie from before
-- this column counts as 0.
ALTER TABLE users ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0;
