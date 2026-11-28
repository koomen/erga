// Repo rule & unit tests for verified architecture demos (demos/*.spec.ts):
// 1. Every permanent architecture spec in demos/ passes Layers 1-4 (static
//    grounding, live gate() + schema + *Step() oracles, lifecycle typestate,
//    and real execution trace conformance).
// 2. Negative tests prove the harness catches every bug class audited in
//    projects/chat-native-bridge/ (premature /llms.txt, unmounted clone write,
//    wrong /oauth/device endpoint, fabricated R2 hop in view_page, silently
//    omitted /api/start, overbroad /plugin/*, stale 12 h TTL, invalid bridge
//    frames, and proposal vs verified planned-tag enforcement).

import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import chatNativeBridge from "../demos/chat-native-bridge.spec.ts";
import { verifyDemoSpec } from "../dev/verify-demo-core.ts";
import { defineDemo, type DemoSpec } from "../shared/demo-spec.ts";

const DEMOS_DIR = resolve(import.meta.dir, "../demos");

test("every permanent architecture demo spec in demos/ passes all 4 verification layers", async () => {
  const specFiles = readdirSync(DEMOS_DIR).filter((f) => f.endsWith(".spec.ts"));
  expect(specFiles.length).toBeGreaterThan(0);

  for (const file of specFiles) {
    const mod = (await import(join(DEMOS_DIR, file))) as { default?: DemoSpec };
    expect(mod.default, `${file} must default-export a DemoSpec`).toBeDefined();
    const ledger = await verifyDemoSpec(mod.default!, { trace: true });
    if (!ledger.ok) {
      console.error(
        `Demo verification failed for ${file}:\n` + ledger.issues.map((i) => `  [${i.layer} ${i.code}] ${i.where}: ${i.message}`).join("\n")
      );
    }
    expect(ledger.ok).toBe(true);
    expect(ledger.status).toBe("verified");
    expect(ledger.plannedCount).toBe(0);
    expect(ledger.combosChecked).toBeGreaterThan(0);
    expect(ledger.gateChecks).toBeGreaterThan(0);
    expect(ledger.tracesChecked).toBeGreaterThan(0);
  }
});

test("L3 catches premature GET /llms.txt emitted by an uninstalled Bridge Daemon", async () => {
  const buggy = defineDemo({
    id: "bug-llms",
    title: "Buggy llms.txt",
    status: "proposal",
    matrix: { axes: { mode: ["sso"] } },
    nodes: {
      sbridge: { title: "Bridge", lifecycle: { states: ["absent", "installed"], initial: "absent", canEmit: ["installed"] } },
      edge: { title: "Gate" },
      worker: { title: "Worker" },
    },
    wires: { bridge: { from: "sbridge", to: "edge", proto: "http" } },
    scenes: [
      {
        id: "connect",
        label: "Connect",
        steps: [
          {
            kind: "hop",
            wire: "bridge",
            from: "sbridge",
            to: "worker",
            via: "edge",
            proto: "http",
            method: "GET",
            path: "/llms.txt",
            label: "GET /llms.txt",
          },
        ],
      },
    ],
  });

  const res = await verifyDemoSpec(buggy, { trace: false });
  expect(res.ok).toBe(false);
  expect(res.issues.some((i) => i.layer == "L3" && i.message.includes('sender "sbridge" is in state "absent"'))).toBe(true);
});

test("L3 catches writing to an unmounted Local Yjs Room Clone", async () => {
  const buggy = defineDemo({
    id: "bug-clone",
    title: "Buggy clone write",
    status: "proposal",
    matrix: { axes: { mode: ["sso"] } },
    nodes: {
      sagent: { title: "Agent", lifecycle: { states: ["running"], initial: "running" } },
      sclone: { title: "Clone", lifecycle: { states: ["absent", "mounted"], initial: "absent", canReceive: ["mounted"] } },
    },
    wires: { disk: { from: "sagent", to: "sclone", proto: "fs" } },
    scenes: [
      {
        id: "connect",
        label: "Connect",
        steps: [{ kind: "hop", wire: "disk", from: "sagent", to: "sclone", proto: "fs", label: "write index.html" }],
      },
    ],
  });

  const res = await verifyDemoSpec(buggy, { trace: false });
  expect(res.ok).toBe(false);
  expect(res.issues.some((i) => i.layer == "L3" && i.message.includes('target "sclone" is in state "absent"'))).toBe(true);
});

test("L1 + L2 live gate() oracle catches POST /oauth/device and invalid openPaths", async () => {
  const buggy = defineDemo({
    id: "bug-device",
    title: "Buggy device auth",
    status: "proposal",
    matrix: { axes: { mode: ["sso"], site: ["other"] } },
    nodes: {
      sbridge: { title: "Bridge", lifecycle: { states: ["installed"], initial: "installed" } },
      edge: {
        title: "Gate",
        openPaths: ["/_edge/sign-in", "/oauth/token", "/oauth/device", "/plugin/*"],
        constants: { shellCookieDays: 0.5 },
      },
      worker: { title: "Worker" },
    },
    wires: { bridge: { from: "sbridge", to: "edge", proto: "http" } },
    scenes: [
      {
        id: "connect",
        label: "Connect",
        steps: [
          {
            kind: "hop",
            wire: "bridge",
            from: "sbridge",
            to: "worker",
            via: "edge",
            proto: "http",
            method: "POST",
            path: "/oauth/device",
            authHeader: "none",
            label: "POST /oauth/device",
            gateExpect: { do: "forward", caller: "none" },
          },
        ],
      },
    ],
  });

  const res = await verifyDemoSpec(buggy, { trace: false });
  expect(res.ok).toBe(false);
  const codes = res.issues.map((i) => `${i.layer}:${i.code}`);
  expect(codes).toContain("L1:INVALID_OPEN_PATH"); // /oauth/device
  expect(codes).toContain("L1:OVERBROAD_OPEN_PATH"); // /plugin/*
  expect(codes).toContain("L1:MISSING_OPEN_PATH"); // omitted /oauth/register
  expect(codes).toContain("L1:CONSTANT_DRIFT"); // 12 h != 30 d
  expect(codes).toContain("L1:MISSING_ROUTE"); // POST /oauth/device
  expect(codes).toContain("L2:GATE_ORACLE"); // gate() returns 401, not forward
});

test("L4 real trace conformance catches fabricated R2 hop in view_page and unacknowledged /api/start omission", async () => {
  // 1. Fabricated Document DO -> R2 hop during view_page
  const fabricatedR2 = defineDemo({
    id: "bug-r2",
    title: "Fabricated R2 screenshot",
    status: "proposal",
    matrix: { axes: { mode: ["sso"] } },
    nodes: { doc: { title: "Doc" }, r2: { title: "R2" } },
    wires: { r2: { from: "doc", to: "r2", proto: "r2" } },
    scenes: [
      {
        id: "stream",
        label: "Stream",
        traceId: "chat-native-bridge/stream",
        steps: [
          {
            kind: "hop",
            wire: "r2",
            from: "doc",
            to: "r2",
            proto: "r2",
            label: "store screenshot png",
            traceMatch: { from: "doc", to: "r2", proto: "r2" },
          },
        ],
      },
    ],
  });

  const r2Res = await verifyDemoSpec(fabricatedR2, { trace: true });
  expect(r2Res.ok).toBe(false);
  expect(r2Res.issues.some((i) => i.layer == "L4" && i.message.includes("store screenshot png"))).toBe(true);

  // 2. Omitting GET /d/:id/api/start without declaring it in elided[]
  const omitStart = defineDemo({
    id: "bug-omit-start",
    title: "Silent /api/start omission",
    status: "proposal",
    matrix: { axes: { mode: ["sso"], bridgeAuth: ["device"] } },
    nodes: { sbridge: { title: "Bridge" }, doc: { title: "Doc" } },
    wires: { yjs: { from: "sbridge", to: "doc", proto: "ws" } },
    scenes: [
      {
        id: "connect",
        label: "Connect",
        traceId: "chat-native-bridge/connect-device",
        elided: [],
        steps: [
          { kind: "hop", wire: "yjs", from: "sbridge", to: "doc", proto: "ws", method: "WS", path: "/d/:id/api/room", label: "WS room" },
        ],
      },
    ],
  });

  const omitRes = await verifyDemoSpec(omitStart, { trace: true });
  expect(omitRes.ok).toBe(false);
  expect(omitRes.issues.some((i) => i.layer == "L4" && i.message.includes("/d/doc1/api/start"))).toBe(true);
});

test("L2 catches malformed bridge frames and wrong *Step() machine expectations; L1 enforces proposal vs verified planned tags", async () => {
  const badFrameAndPlan = defineDemo({
    id: "bug-frame-planned",
    title: "Bad frame and planned in verified",
    status: "verified",
    matrix: { axes: { mode: ["sso"] } },
    nodes: {
      sbridge: { title: "Bridge", planned: true },
      person: { title: "Person" },
    },
    wires: { bridge: { from: "sbridge", to: "person", proto: "ws" } },
    scenes: [
      {
        id: "s1",
        label: "S1",
        steps: [
          {
            kind: "hop",
            wire: "bridge",
            from: "sbridge",
            to: "person",
            proto: "ws",
            label: "bogus frame",
            bridgeFrame: { direction: "fromBridge", frame: { type: "not_a_real_frame" } },
            machineCheck: {
              machine: "updateStep",
              state: { at: "idle", version: "v1" },
              event: { on: "swapped", nextVersion: "v2", bundlePath: "/tmp/b.js", busy: true },
              expectAt: "ready", // wrong: busy: true enters pending_restart!
            },
          },
        ],
      },
    ],
  });

  const res = await verifyDemoSpec(badFrameAndPlan, { trace: false });
  expect(res.ok).toBe(false);
  expect(res.issues.some((i) => i.layer == "L1" && i.code == "PLANNED_IN_VERIFIED")).toBe(true);
  expect(res.issues.some((i) => i.layer == "L2" && i.code == "BRIDGE_SCHEMA")).toBe(true);
  expect(res.issues.some((i) => i.layer == "L2" && i.code == "MACHINE_ORACLE")).toBe(true);

  // Same planned node is accepted and tallied in proposal mode
  const proposal = defineDemo({
    id: "proposal-ok",
    title: "Proposal mode with planned item",
    status: "proposal",
    matrix: { axes: { mode: ["sso"] } },
    nodes: {
      future: { title: "Future Service", planned: true, bindsTo: { files: ["does/not/exist/yet.ts"], planned: true } },
    },
    wires: {},
    scenes: [],
  });
  const propRes = await verifyDemoSpec(proposal, { trace: false });
  expect(propRes.ok).toBe(true);
  expect(propRes.plannedCount).toBe(1);
  expect(propRes.plannedItems).toEqual(["node:future"]);
});

test("chat-native-bridge spec checks PKCE trace too", async () => {
  const pkceSpec: DemoSpec = {
    ...chatNativeBridge,
    scenes: chatNativeBridge.scenes.map((s) =>
      s.id == "connect"
        ? {
            ...s,
            traceId: "chat-native-bridge/connect-pkce",
          }
        : { ...s, traceId: undefined }
    ),
  };
  const res = await verifyDemoSpec(pkceSpec, { trace: true });
  if (!res.ok) console.error(res.issues);
  expect(res.ok).toBe(true);
});
