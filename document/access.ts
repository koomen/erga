// Who may do what with a document. The directory (server/directory/) decides
// it, by its own rule; the document keeps a copy of its permissions and asks
// that rule itself (Document.authorize), so a request asks the database
// nothing.

/** A person's role in a document: whoever made it owns it; others are given editor or viewer. */
export type Role = "owner" | "editor" | "viewer";

/** Someone asking, as the front door said (x-erga-who): the directory's Who, which the document only passes on to the directory's rule. */
export interface Asker {
  login: string;
  test?: boolean;
  by?: string;
}

/** What a role lets someone do with the document's files and its agent: edit, view, or nothing. */
export const accessOf = (role: Role | null): "edit" | "view" | null =>
  role == "owner" || role == "editor" ? "edit" : role == "viewer" ? "view" : null;
