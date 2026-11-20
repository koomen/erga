-- From here the admins see who sent each feedback (server/admin/feedback.ts). Each one kept until now was sent under
-- the words "without your name": it keeps that, so its login and how it was sent go, and it shows as "Sent without a
-- name". (No table and no column goes.)
UPDATE feedback SET login = '', via = NULL;
