-- A feedback's context (shared/feedback-context.ts), as JSON: what the person's editor told the server with the
-- message that their agent sent it for (the page, its HTML near the caret, the last keys), while the setting
-- feedback_context was on. Null: sent with none (from the dialog, by an outside agent, or with the setting off).
ALTER TABLE feedback ADD COLUMN context TEXT;
