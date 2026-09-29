import { test, expect } from "bun:test";
import { parseMarkdown } from "../src/markdown/parser";
import { iterate } from "../src/markdown/tree";
import { lezerNodes } from "./reference";
import { corpus, randomDoc } from "./corpus";

function ourNodes(text: string): string[] {
  const out: string[] = [];
  iterate(parseMarkdown(text), { enter(n) { out.push(`${n.name}[${n.from},${n.to}]`); } });
  return out;
}

test("parser matches Lezer on the corpus", () => {
  for (const text of corpus) expect({ text, nodes: ourNodes(text) }).toEqual({ text, nodes: lezerNodes(text) });
});

test("parser matches Lezer on random documents", () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 3000; i++) {
    const text = randomDoc(rand);
    expect({ text, nodes: ourNodes(text) }).toEqual({ text, nodes: lezerNodes(text) });
  }
});
