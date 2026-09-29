// Everything the editor needs from npm, gathered onto one global (window.Vendor)
// so index.html can load it as a classic script and open straight from file://.
// Rebuild with ./vendor/build.sh; see README.md.
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection, ViewPlugin, Decoration } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";

window.Vendor = {
  EditorState, EditorSelection,
  EditorView, keymap, placeholder, drawSelection, ViewPlugin, Decoration,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, HighlightStyle, syntaxTree,
  markdown, markdownLanguage, markdownKeymap,
  tags, marked, DOMPurify,
};
