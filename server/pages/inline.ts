// The scripts and styles a page carries inline (client/inline/, as server/pages/inline-code.ts has them built): the
// scripts that must run as the page parses, before it paints, or before the page's other scripts, and the styles that
// must be there before it paints.

import { SCRIPTS, STYLES } from "./inline-code.ts";
import { jsonInScript } from "../../shared/html.ts";

/** The function of script `name` of client/inline/, as an expression. */
export const inlineFunction = (name: keyof typeof SCRIPTS) => SCRIPTS[name].replace(/<\/script/gi, "<\\/script");

/** The script `name` of client/inline/, called with `args`: a statement, for inside a <script> element. */
export const inlineCall = (name: keyof typeof SCRIPTS, ...args: unknown[]) =>
  `${inlineFunction(name)}(${args.map(jsonInScript).join(",")});`;

/** inlineCall in a <script> element of its own. */
export const inlineScript = (name: keyof typeof SCRIPTS, ...args: unknown[]) => `<script>${inlineCall(name, ...args)}</script>`;

/** The stylesheet `name` of client/inline/ (name.css), as text: for inside a <style> element. */
export const inlineStyle = (name: keyof typeof STYLES) => STYLES[name];
