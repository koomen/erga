// Unit tests for TerminalBackend adapters:
// - HerdrCoreBackend against a fake Unix-socket framed herdr-core server
//   (hello, framed RPC, events.subscribe + multi-line batches + missed resync,
//    herdr-app spaces + labels + recursive parent child resolution,
//    framed terminal.attach DATA/RESIZE/CREDIT/CLOSE, doc.get/set, reconnect)
// - RexBackend against a mock `rex` CLI binary (REX_BIN)

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { encodeHcFrame, HerdrCoreBackend } from "../bridge/backends/herdr-core.ts";
import { RexBackend } from "../bridge/backends/rex.ts";
import { herdrSocketPath, type BackendEvent } from "../bridge/core/backend.ts";

async function until(fn: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !fn(); ) await new Promise((r) => setTimeout(r, 15));
  if (!fn()) throw new Error("Timed out waiting for condition");
}

interface FakeHcTerminal {
  address: string;
  name?: string | null;
  argv: string[];
  cwd: string;
  state: "live" | "finished";
  status: Record<string, unknown> | null;
  turn: number;
  parent: string | null;
  labels: Record<string, string>;
}

function startFakeHerdrCore(sockPath: string) {
  const terminals = new Map<string, FakeHcTerminal>([
    [
      "t1",
      {
        address: "t1",
        name: "manager",
        argv: ["agy"],
        cwd: "/repo",
        state: "live",
        status: { state: "idle", app: "antigravity" },
        turn: 0,
        parent: null,
        labels: { "herdr.space": "sp1" },
      },
    ],
    [
      "t2",
      {
        address: "t2",
        name: null,
        argv: ["claude"],
        cwd: "/repo/wt",
        state: "live",
        status: { state: "working", app: "claude" },
        turn: 1,
        parent: "t1",
        labels: {},
      },
    ],
    [
      "devbox/t3",
      {
        address: "devbox/t3",
        name: null,
        argv: ["codex"],
        cwd: "/srv/app",
        state: "live",
        status: { state: "done", app: "codex" },
        turn: 2,
        parent: "t2",
        labels: {},
      },
    ],
  ]);

  const docs = new Map<string, { version: number; value: unknown }>([
    [
      "herdr-app",
      {
        version: 1,
        value: {
          spaces: [
            {
              id: "sp1",
              name: "Erga Work",
              folder: "/repo",
              tabs: [{ id: "tab1", name: "Main", root: { children: [{ content: { terminal: "t1" } }] } }],
            },
          ],
        },
      },
    ],
  ]);

  let activeSock: Socket | null = null;
  let nextCh = 1;
  let termEventCh = 0;
  let docEventCh = 0;
  const receivedInput: Array<{ ch: number; data: string }> = [];
  const receivedResizes: Array<{ ch: number; cols: number; rows: number }> = [];
  const receivedCredits: Array<{ ch: number; bytes: number }> = [];
  const sentCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const closedChannels: number[] = [];

  const server = createServer((sock) => {
    activeSock = sock;
    let mode: "line" | "framed" = "line";
    let buf: Buffer = Buffer.alloc(0);

    const handleRpc = (msg: { id: number; method: string; params?: Record<string, unknown> }) => {
      const p = msg.params ?? {};
      sentCalls.push({ method: msg.method, params: p });
      const reply = (result: unknown) => {
        const json = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (mode == "line") sock.write(json + "\n");
        else sock.write(encodeHcFrame(0, 0, new TextEncoder().encode(json)));
      };
      if (msg.method == "hello") {
        reply({ version: "0.1.22", framed: true, generation: 1, core: { id: "c1", name: "fake" }, methods: [], features: [] });
        if (p.framed) mode = "framed";
        return;
      }
      if (msg.method == "terminal.list") return reply({ terminals: [...terminals.values()], hidden_finished: 0, machines: [] });
      if (msg.method == "terminal.get") return reply(terminals.get(String(p.terminal)));
      if (msg.method == "doc.get") return reply(docs.get(String(p.name)) ?? { version: 0, value: null });
      if (msg.method == "doc.set") {
        const v = Number(p.version ?? 0) + 1;
        docs.set(String(p.name), { version: v, value: p.value });
        return reply({ version: v });
      }
      if (msg.method == "events.subscribe") {
        const ch = nextCh++;
        if (Array.isArray(p.docs) && p.docs.length) {
          docEventCh = ch;
          return reply({ channel: ch, seq: 1, terminals: [] });
        }
        termEventCh = ch;
        return reply({ channel: ch, seq: 1, terminals: [...terminals.values()] });
      }
      if (msg.method == "terminal.attach") {
        const ch = nextCh++;
        const t = terminals.get(String(p.terminal))!;
        reply({ channel: ch, terminal: t, resize_notifications: false, automatic_input: true });
        sock.write(encodeHcFrame(ch, 0, new TextEncoder().encode(`\x1b[HWelcome ${t.address}`)));
        return;
      }
      if (msg.method == "terminal.send") return reply({ started: true, status: null, turn: 0 });
      if (msg.method == "terminal.interrupt") return reply({ ok: true });
      if (msg.method == "terminal.run") {
        const t: FakeHcTerminal = {
          address: "t9",
          name: (p.name as string) ?? null,
          argv: (p.argv as string[]) ?? ["sh"],
          cwd: String(p.cwd ?? "/repo"),
          state: "live",
          status: null,
          turn: 0,
          parent: null,
          labels: (p.labels as Record<string, string>) ?? {},
        };
        terminals.set(t.address, t);
        return reply({ terminal: t });
      }
      reply({});
    };

    sock.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (mode == "line") {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        handleRpc(JSON.parse(line));
      }
      while (mode == "framed" && buf.length >= 9) {
        const ch = buf.readUInt32LE(0);
        const kind = buf.readUInt8(4);
        const len = buf.readUInt32LE(5);
        if (buf.length < 9 + len) break;
        const payload = buf.subarray(9, 9 + len);
        buf = buf.subarray(9 + len);
        if (ch == 0 && kind == 0) {
          handleRpc(JSON.parse(payload.toString("utf8")));
        } else if (kind == 0) {
          receivedInput.push({ ch, data: payload.toString("utf8") });
        } else if (kind == 1 && payload.length >= 4) {
          receivedCredits.push({ ch, bytes: payload.readUInt32LE(0) });
        } else if (kind == 2) {
          closedChannels.push(ch);
          sock.write(encodeHcFrame(ch, 2, new Uint8Array(0)));
        } else if (kind == 3 && payload.length >= 4) {
          receivedResizes.push({ ch, cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) });
        }
      }
    });
  });

  return {
    listen: () => new Promise<void>((resolve) => server.listen(sockPath, resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        activeSock?.destroy();
        server.close(() => resolve());
      }),
    dropClient: () => activeSock?.destroy(),
    pushTermEvents: (lines: object[]) => {
      if (!activeSock || !termEventCh) return;
      const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      activeSock.write(encodeHcFrame(termEventCh, 0, new TextEncoder().encode(body)));
    },
    pushDocEvent: (name: string, version: number) => {
      if (!activeSock || !docEventCh) return;
      const body = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "doc", seq: 9, data: { name, version } } }) + "\n";
      activeSock.write(encodeHcFrame(docEventCh, 0, new TextEncoder().encode(body)));
    },
    pushPtyBytes: (ch: number, bytes: Uint8Array) => activeSock?.write(encodeHcFrame(ch, 0, bytes)),
    receivedInput,
    receivedResizes,
    receivedCredits,
    closedChannels,
    sentCalls,
    docs,
  };
}

test("HerdrCoreBackend resolves spaces + parent chains, streams framed PTY/OSC 7501, sends credits, and reconnects", async () => {
  const dir = mkdtempSync("/tmp/erga-hc-u-");
  const sockPath = join(dir, "hc.sock");
  const fake = startFakeHerdrCore(sockPath);
  await fake.listen();

  const hc = new HerdrCoreBackend({ socketPath: sockPath, reconnect: true });
  const events: BackendEvent[] = [];
  const unsub = hc.subscribe((ev) => events.push(ev));

  try {
    const info = await hc.connect();
    expect(info.version).toBe("0.1.22");

    // Whole space resolution pulls t1 (tab pane), t2 (child of t1), and devbox/t3 (child of t2, SSH remote).
    const spaces = await hc.listSpaces();
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("Erga Work");
    expect(spaces[0].terminals.map((t) => t.id)).toEqual(["t1", "t2", "devbox/t3"]);
    expect(spaces[0].terminals[2].host).toBe("devbox");

    // Target resolution: single terminal vs whole space.
    const single = await hc.resolveTarget({ env: { HC_TERMINAL_ID: "t2" } });
    expect(single.scope).toBe("single");
    expect(single.terminals.map((t) => t.id)).toEqual(["t2"]);

    const whole = await hc.resolveTarget({ space: true, env: { HC_TERMINAL_ID: "t2" } });
    expect(whole.scope).toBe("space");
    expect(whole.spaceId).toBe("sp1");
    expect(whole.activeTerminal).toBe("t2");
    expect(whole.terminals.map((t) => t.id)).toEqual(["t1", "t2", "devbox/t3"]);

    // Multi-line framed OSC 7501 status + turn events in one packet.
    fake.pushTermEvents([
      {
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "status",
          terminal: "t2",
          seq: 2,
          data: { status: { state: "blocked", kind: "permission", app: "claude", msg: "Run test?" } },
        },
      },
      { jsonrpc: "2.0", method: "event", params: { type: "turn", terminal: "t2", seq: 3, data: { state: "blocked", turn: 2 } } },
    ]);
    await until(() => events.some((e) => e.type == "turn_done" && e.terminalId == "t2" && e.turn == 2));
    const statusEv = events.find((e) => e.type == "terminal_changed" && e.terminal.id == "t2" && e.terminal.status?.state == "blocked");
    expect(statusEv?.type == "terminal_changed" && statusEv.terminal.status?.kind).toBe("permission");

    // herdr-app doc change notifies spaces_changed.
    fake.pushDocEvent("herdr-app", 2);
    await until(() => events.some((e) => e.type == "spaces_changed"));

    // Framed terminal.attach: initial paint, bidirectional input, resize, credit replenishment (>32 KiB), and close.
    const chunks: string[] = [];
    let closedReason: string | undefined;
    const att = await hc.attach(
      "t2",
      { cols: 90, rows: 30 },
      (bytes) => chunks.push(new TextDecoder().decode(bytes)),
      (reason) => (closedReason = reason)
    );
    await until(() => chunks.join("").includes("Welcome t2"));

    att.write(new TextEncoder().encode("ls\r"));
    att.resize(120, 40);
    await until(() => fake.receivedInput.some((x) => x.data == "ls\r") && fake.receivedResizes.some((r) => r.cols == 120 && r.rows == 40));

    // Stream >32 KiB to trigger automatic CREDIT replenishment frame.
    const attachCh = fake.receivedInput[0].ch;
    fake.pushPtyBytes(attachCh, new Uint8Array(40 * 1024).fill(65));
    await until(() => fake.receivedCredits.some((c) => c.ch == attachCh && c.bytes >= 32 * 1024));

    att.close();
    await until(() => fake.closedChannels.includes(attachCh));
    expect(closedReason).toBeUndefined();

    // Persistence via doc.get / doc.set ("erga-bridge").
    await hc.setState("erga-bridge", { bindings: [{ docId: "doc1" }] });
    expect(await hc.getState<unknown>("erga-bridge")).toEqual({ bindings: [{ docId: "doc1" }] });

    // Send & interrupt RPCs.
    await hc.send("t2", "hello");
    await hc.interrupt("t2");
    expect(fake.sentCalls.some((c) => c.method == "terminal.send" && c.params.text == "hello")).toBe(true);
    expect(fake.sentCalls.some((c) => c.method == "terminal.interrupt" && c.params.terminal == "t2")).toBe(true);

    // Simulated herdr-core restart -> automatic reconnect emits resync.
    events.length = 0;
    fake.dropClient();
    await until(() => events.some((e) => e.type == "resync"));
  } finally {
    unsub();
    await hc.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RexBackend lists sessions/blocks with OSC 7501, resolves single vs space targets, and forwards send/interrupt", async () => {
  const dir = mkdtempSync("/tmp/erga-rex-u-");
  const logFile = join(dir, "calls.log");
  const bin = join(dir, "rex");
  const script = join(dir, "mock-rex.js");
  writeFileSync(
    script,
    `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] == "--version") { console.log("rex 0.4.1"); process.exit(0); }
if (args[0] == "ls") {
  console.log(JSON.stringify([
    {
      id: "sess-erga",
      name: "erga",
      cwd: "/repo",
      windows: [
        { id: "w1", name: "main", blocks: [
          { id: "blk:a1", app: "antigravity", cwd: "/repo", alive: true, status: { state: "idle", app: "antigravity" }, turn: 1 },
          { id: "blk:b2", app: "claude", cwd: "/repo", alive: true, status: { state: "blocked", kind: "permission", app: "claude", msg: "Allow?" }, turn: 3 },
        ]}
      ]
    }
  ]));
  process.exit(0);
}
if (args[0] == "new") {
  console.log(JSON.stringify({ id: "blk:c3", app: "sh", cwd: "/repo", alive: true, status: null, turn: 0 }));
  process.exit(0);
}
process.exit(0);
`
  );
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);

  const rex = new RexBackend({ bin, pollMs: 60_000 });
  try {
    expect((await rex.connect()).version).toBe("0.4.1");
    const spaces = await rex.listSpaces();
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("erga");
    expect(spaces[0].terminals.map((t) => [t.id, t.status?.state, t.status?.kind])).toEqual([
      ["blk:a1", "idle", undefined],
      ["blk:b2", "blocked", "permission"],
    ]);

    const single = await rex.resolveTarget({ env: { REX_BLOCK_ID: "blk:b2" } });
    expect(single.scope).toBe("single");
    expect(single.activeTerminal).toBe("blk:b2");

    const whole = await rex.resolveTarget({ space: true, env: { REX_SESSION: "erga", REX_BLOCK_ID: "blk:b2" } });
    expect(whole.scope).toBe("space");
    expect(whole.spaceId).toBe("sess-erga");
    expect(whole.terminals.map((t) => t.id)).toEqual(["blk:a1", "blk:b2"]);
    expect(whole.activeTerminal).toBe("blk:b2");

    await rex.send("blk:b2", "hello rex");
    await rex.interrupt("blk:b2");
    const spawned = await rex.spawn({ cwd: "/repo", spaceId: "sess-erga", name: "worker" });
    expect(spawned.id).toBe("blk:c3");
  } finally {
    await rex.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("herdrSocketPath respects HC_SOCKET > HC_SESSION > HC_TERMINAL_SOCKET > default", () => {
  expect(herdrSocketPath({ HC_SOCKET: "/a.sock", HC_SESSION: "s", HC_TERMINAL_SOCKET: "/b.sock" })).toBe("/a.sock");
  expect(herdrSocketPath({ XDG_STATE_HOME: "/st", HC_SESSION: "s", HC_TERMINAL_SOCKET: "/b.sock" })).toBe("/st/herdr-core/s/s.sock");
  expect(herdrSocketPath({ XDG_STATE_HOME: "/st", HC_TERMINAL_SOCKET: "/b.sock" })).toBe("/b.sock");
  expect(herdrSocketPath({ XDG_STATE_HOME: "/st" })).toBe("/st/herdr-core/default/default.sock");
});
