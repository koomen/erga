// Key bindings. Names look like "Mod-Shift-z" or "Alt-ArrowLeft" ("Mod" is
// Cmd on macOS, Ctrl elsewhere). Resolution follows CodeMirror's rules
// (including the fallback to the unshifted/unmodified key via keyCode, which
// makes Cmd-Alt-1 match on macOS where the key itself reports "¡").

import type { EditorView } from "./view";
import { isMac } from "./dom";

export type Command = (view: EditorView) => boolean;

export interface KeyBinding {
  key?: string;
  mac?: string;
  run?: Command;
  shift?: Command;
  preventDefault?: boolean;
}

const base: Record<number, string> = {
  8: "Backspace", 9: "Tab", 10: "Enter", 12: "NumLock", 13: "Enter", 16: "Shift", 17: "Control", 18: "Alt", 20: "CapsLock",
  27: "Escape", 32: " ", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight",
  40: "ArrowDown", 44: "PrintScreen", 45: "Insert", 46: "Delete", 59: ";", 61: "=", 91: "Meta", 92: "Meta", 106: "*", 107: "+",
  108: ",", 109: "-", 110: ".", 111: "/", 144: "NumLock", 145: "ScrollLock", 160: "Shift", 161: "Shift", 162: "Control",
  163: "Control", 164: "Alt", 165: "Alt", 173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`",
  219: "[", 220: "\\", 221: "]", 222: "'",
};
const shift: Record<number, string> = {
  48: ")", 49: "!", 50: "@", 51: "#", 52: "$", 53: "%", 54: "^", 55: "&", 56: "*", 57: "(", 59: ":", 61: "+", 173: "_",
  186: ":", 187: "+", 188: "<", 189: "_", 190: ">", 191: "?", 192: "~", 219: "{", 220: "|", 221: "}", 222: '"',
};
for (let i = 0; i < 10; i++) base[48 + i] = base[96 + i] = String(i);
for (let i = 1; i <= 24; i++) base[i + 111] = "F" + i;
for (let i = 65; i <= 90; i++) {
  base[i] = String.fromCharCode(i + 32);
  shift[i] = String.fromCharCode(i);
}
for (const code in base) if (!(code in shift)) shift[code] = base[code];

function keyName(event: KeyboardEvent): string {
  const ignoreKey = (isMac && event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey) || event.key == "Unidentified";
  let name = (!ignoreKey && event.key) || (event.shiftKey ? shift : base)[event.keyCode] || event.key || "Unidentified";
  if (name == "Esc") name = "Escape";
  if (name == "Del") name = "Delete";
  if (name == "Left") name = "ArrowLeft";
  if (name == "Up") name = "ArrowUp";
  if (name == "Right") name = "ArrowRight";
  if (name == "Down") name = "ArrowDown";
  return name;
}

function normalizeKeyName(name: string): string {
  const parts = name.split(/-(?!$)/);
  let result = parts[parts.length - 1];
  if (result == "Space") result = " ";
  let alt = false, ctrl = false, shiftMod = false, meta = false;
  for (let i = 0; i < parts.length - 1; ++i) {
    const mod = parts[i];
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shiftMod = true;
    else if (/^mod$/i.test(mod)) { if (isMac) meta = true; else ctrl = true; }
    else throw new Error("Unrecognized modifier name: " + mod);
  }
  if (alt) result = "Alt-" + result;
  if (ctrl) result = "Ctrl-" + result;
  if (meta) result = "Meta-" + result;
  if (shiftMod) result = "Shift-" + result;
  return result;
}

function modifiers(name: string, event: KeyboardEvent, shiftMod: boolean): string {
  if (event.altKey) name = "Alt-" + name;
  if (event.ctrlKey) name = "Ctrl-" + name;
  if (event.metaKey) name = "Meta-" + name;
  if (shiftMod && event.shiftKey) name = "Shift-" + name;
  return name;
}

interface Binding { run: Command[]; preventDefault: boolean }

export class Keymap {
  private bound: Record<string, Binding> = Object.create(null);

  constructor(bindings: readonly KeyBinding[]) {
    const add = (key: string, command: Command | undefined, preventDefault?: boolean) => {
      const name = normalizeKeyName(key);
      const binding = this.bound[name] || (this.bound[name] = { run: [], preventDefault: false });
      if (command) binding.run.push(command);
      if (preventDefault) binding.preventDefault = true;
    };
    for (const b of bindings) {
      const name = (isMac && b.mac) || b.key;
      if (!name) continue;
      add(name, b.run, b.preventDefault);
      if (b.shift) add("Shift-" + name, b.shift, b.preventDefault);
    }
  }

  /** Run the commands bound to this key event. Returns true when the event was handled. */
  run(view: EditorView, event: KeyboardEvent): boolean {
    const name = keyName(event);
    const isChar = name != " " && (name.length == 1 || (name.length == 2 && /[\ud800-\udbff]/.test(name[0])));
    let prevented = false;
    const ran = new Set<Command>();
    const runFor = (binding: Binding | undefined) => {
      if (binding) {
        for (const cmd of binding.run) {
          if (!ran.has(cmd)) {
            ran.add(cmd);
            if (cmd(view)) return true;
          }
        }
        if (binding.preventDefault) prevented = true;
      }
      return false;
    };
    let handled = false, baseName: string | undefined, shiftName: string | undefined;
    if (runFor(this.bound[modifiers(name, event, !isChar)])) {
      handled = true;
    } else if (isChar && (event.altKey || event.metaKey || event.ctrlKey) &&
      !(isMac && event.altKey && !(event.ctrlKey || event.metaKey)) &&
      (baseName = base[event.keyCode]) && baseName != name) {
      if (runFor(this.bound[modifiers(baseName, event, true)])) handled = true;
      else if (event.shiftKey && (shiftName = shift[event.keyCode]) != name && shiftName != baseName &&
        runFor(this.bound[modifiers(shiftName!, event, false)])) handled = true;
    } else if (isChar && event.shiftKey && runFor(this.bound[modifiers(name, event, true)])) {
      handled = true;
    }
    return handled || prevented;
  }
}
