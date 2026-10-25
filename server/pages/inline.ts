// The scripts a page carries inline (client/inline/, as server/pages/inline-scripts.ts has them built): those that
// must run as the page parses, before it paints, or before the page's other scripts.

import { INLINE } from "./inline-scripts.ts";

/** A value as JSON that can't end the script element it's in. */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The function of script `name` of client/inline/, as an expression. */
export const inlineFunction = (name: keyof typeof INLINE) => INLINE[name].replace(/<\/script/gi, "<\\/script");

/** The script `name` of client/inline/, called with `args`: a statement, for inside a <script> element. */
export const inlineCall = (name: keyof typeof INLINE, ...args: unknown[]) => `${inlineFunction(name)}(${args.map(json).join(",")});`;

/** inlineCall in a <script> element of its own. */
export const inlineScript = (name: keyof typeof INLINE, ...args: unknown[]) => `<script>${inlineCall(name, ...args)}</script>`;
