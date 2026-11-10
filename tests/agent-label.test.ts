// How an agent shows on a page (shared/attribution.ts, agentLabel): a short name, and one word for what it does.
import { expect, test } from "bun:test";
import { agentLabel, VIA } from "../shared/attribution.ts";

test("a shared agent shows by its connection's name; the person's own agent as Agent", () => {
  expect(
    agentLabel(
      { name: "Pete, via a shared agent (Claude Code (erga))", via: VIA.token("Claude Code (erga)") },
      "looking at the page",
      false
    )
  ).toEqual({
    label: "Claude Code · looking",
    title: "Pete, via a shared agent (Claude Code (erga)) · looking at the page",
  });
  expect(agentLabel({ name: "Pete, via their agent", via: VIA.agent }, "editing index.html", false).label).toBe("Agent · editing");
  expect(agentLabel({ name: "Pete, via a shared agent (CI)", via: VIA.token("CI") }, null, false).label).toBe("CI");
  expect(agentLabel({ name: "Pete, via a shared agent (no label)", via: VIA.token("") }, "working", false).label).toBe("Agent · working");
});

test("with more than one person in the document, it says whose", () => {
  expect(
    agentLabel({ name: "Pete, via a shared agent (Claude Code (erga))", via: VIA.token("Claude Code (erga)") }, "reading", true).label
  ).toBe("Pete’s Claude Code · reading");
  expect(agentLabel({ name: "Ada, via their agent", via: VIA.agent }, "editing", true).label).toBe("Ada’s agent · editing");
});

test("a name with no via stays as it is", () => {
  expect(agentLabel({ name: "On disk" }, null, true)).toEqual({ label: "On disk", title: "On disk" });
});
