// A glob pattern as a RegExp over a document's paths: ls's `glob` (server/operations/editor.ts), grep's (agents/document/tools.ts).

import { escapeRe } from "./html";

/** "**" any folders, "*" any name part, "?" one character, "{a,b}" either; a pattern without a slash matches at any depth, like find -name. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c == "*") {
      if (glob[i + 1] == "*") {
        re += glob[i + 2] == "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] == "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c == "?") re += "[^/]";
    else if (c == "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re +=
          "(?:" +
          glob
            .slice(i + 1, end)
            .split(",")
            .map(escapeRe)
            .join("|") +
          ")";
        i = end;
      } else re += "\\{";
    } else re += escapeRe(c);
  }
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}
