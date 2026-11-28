// Deterministic verification engine for Erga architecture demos (Layers 1-4):
//   L1 Static Grounding    — routes, bindings, D1 tables, files, exports, constants, planned-mode guard
//   L2 Executable Oracles  — real gate(req, cfg, port), bridge-schema.ts decoders, real *Step() state machines
//   L3 Lifecycle Typestate — pure lifecycleStep across all valid toggle matrix combinations
//   L4 Trace Conformance   — real Erga execution traces checked for order-preserving soundness & explicit elisions

import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Context from "effect/Context";
import { HttpApi } from "effect/http-api";
import { bridgeStep, EMPTY_BRIDGES, type BridgeEvent, type BridgeState } from "../agents/person/bridge.ts";
import { updateStep, type UpdateEvent, type UpdateState } from "../bridge/core/updater.ts";
import { blockedStep, threadEventStep, type BlockedEvent, type BlockedState } from "../client/common/agent-panel.ts";
import { ACTIONS as DOCUMENT_ACTIONS, Api, Audited } from "../document/api/api.ts";
import {
  ACCESS_OPEN,
  CALLBACK,
  DEVICE_AUTH,
  DEVICE_DONE,
  DEVICE_POLL,
  gate,
  GATE_COOKIES,
  HEALTH,
  PATTERNS,
  RESOURCE,
  seal,
  SERVER,
  SIGN_IN,
  SIGN_IN_DAYS,
  SIGN_IN_DAYS_MAX,
  SIGN_OUT,
  type Config as GateConfig,
  type Port as GatePort,
  type Req as GateReq,
} from "../gate/core.ts";
import { GRANT_DAYS } from "../server/identity/grants.ts";
import { OPERATIONS } from "../server/operations/index.ts";
import { parseFromBridge, parseToBridge } from "../shared/bridge-schema.ts";
import {
  expandMatrix,
  initialLifecycle,
  isRefValue,
  lifecycleStep,
  resolveSteps,
  type CodeRef,
  type DemoSpec,
  type HopStep,
  type MachineCheck,
  type ParallelStep,
  type StateStep,
  type VerificationIssue,
  type VerificationLedger,
} from "../shared/demo-spec.ts";
import { pathPattern, type Action } from "../shared/routes.ts";
import { checkTraceConformance } from "./trace.ts";
import { captureErgaTrace } from "./trace-scenarios.ts";

const ROOT = resolve(import.meta.dir, "..");

const ROUTE_FILES = [
  "server/app.ts",
  "server/api.ts",
  "server/admin/routes.ts",
  "server/documents/routes.ts",
  "server/identity/tokens-page.ts",
  "server/news/routes.ts",
  "agents/person/routes.ts",
  "agents/page-llm.ts",
  "cloudflare/deploy-routes.ts",
];

/** Exact open paths handled or forwarded without proof by gate/core.ts when OAuth is enabled. */
export const GATE_OPEN_PATHS: readonly string[] = [
  SIGN_IN,
  CALLBACK,
  "/_edge/vouch",
  "/_edge/accept",
  RESOURCE,
  SERVER,
  ...PATTERNS.forms,
  DEVICE_AUTH,
  DEVICE_POLL,
  "/llms.txt",
  "/plugin/install.sh",
  "/plugin/bridge.json",
  "/plugin/bridge.js",
];

const GATE_ALL_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: SIGN_IN },
  { method: "GET", path: CALLBACK },
  { method: "GET", path: SIGN_OUT },
  { method: "POST", path: SIGN_OUT },
  { method: "GET", path: "/_edge/vouch" },
  { method: "GET", path: "/_edge/accept" },
  { method: "GET", path: RESOURCE },
  { method: "GET", path: SERVER },
  { method: "POST", path: "/oauth/token" },
  { method: "POST", path: "/oauth/register" },
  { method: "GET", path: HEALTH },
  // Document room WebSocket & start endpoints (served in document/api/host.ts & cloudflare/objects/document.ts)
  { method: "GET", path: "/d/<id>/api/start" },
  { method: "WS", path: "/d/<id>/api/room" },
  { method: "GET", path: "/<owner>/<slug>/api/doc" },
  { method: "GET", path: "/d/<id>/api/key" },
  { method: "GET", path: "/<owner>/<slug>" },
  { method: "GET", path: "/t/<pass>/" },
  { method: "GET", path: "/documents" },
  { method: "GET", path: "/" },
  { method: "WS", path: "/api/agent/bridge" },
  { method: "WS", path: "/api/agent/events" },
  { method: "GET", path: "/callback" },
  { method: "GET", path: DEVICE_DONE },
];

export interface CodebaseIndex {
  readonly routes: readonly { method: string; path: string }[];
  readonly bindings: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
  readonly machines: ReadonlySet<string>;
  readonly refs: Readonly<Record<CodeRef, unknown>>;
}

let cachedIndex: Promise<CodebaseIndex> | null = null;

/** Builds a cached structural index directly from Erga's live source files. */
export async function loadCodebaseIndex(): Promise<CodebaseIndex> {
  if (cachedIndex) return cachedIndex;
  cachedIndex = (async () => {
    const routes: { method: string; path: string }[] = [...GATE_ALL_ROUTES];

    for (const file of ROUTE_FILES) {
      const m = (await import(join(ROOT, file))) as { ROUTES?: Action[]; PAGES?: Action[] };
      for (const r of [...(m.ROUTES ?? []), ...(m.PAGES ?? [])]) {
        routes.push({ method: r.method, path: r.path });
      }
    }

    HttpApi.reflect(Api, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        const audit = Context.getOption(endpoint.annotations, Audited);
        if (audit._tag == "Some" || endpoint.path) {
          routes.push({ method: endpoint.method, path: `/d/<id>${endpoint.path}` });
          routes.push({ method: endpoint.method, path: endpoint.path });
        }
      },
    });

    for (const a of DOCUMENT_ACTIONS) {
      routes.push({ method: a.method, path: a.path });
      routes.push({ method: a.method, path: `/d/<id>${a.path}` });
    }
    for (const op of OPERATIONS) {
      routes.push({ method: "POST", path: `/api/tools/${op.name}` });
    }

    // Worker bindings from cloudflare.config.ts
    const cfText = readFileSync(join(ROOT, "cloudflare.config.ts"), "utf8");
    const bindings = new Set<string>();
    for (const m of cfText.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*(?:bindings\.|mode\s*==|local\()/gm)) {
      bindings.add(m[1]);
    }
    for (const m of cfText.matchAll(/\b([A-Z][A-Z0-9_]+):\s*bindings\./g)) bindings.add(m[1]);
    for (const m of cfText.matchAll(/exportName:\s*"([^"]+)"/g)) bindings.add(m[1]);

    // SQL tables from server/migrations/*.sql
    const tables = new Set<string>();
    const migDir = join(ROOT, "server/migrations");
    for (const f of readdirSync(migDir).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const m of sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z0-9_]+)/gi)) {
        tables.add(m[1]);
      }
    }

    // Exported *Step() state machines across repo
    const machines = new Set<string>();
    for (const dir of ["agents", "bridge", "client", "document", "server", "shared"]) {
      const base = join(ROOT, dir);
      if (!existsSync(base)) continue;
      for (const rel of readdirSync(base, { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts")) continue;
        const txt = readFileSync(join(base, rel), "utf8");
        for (const m of txt.matchAll(/export\s+function\s+([a-zA-Z0-9_]+Step)\s*\(/g)) machines.add(m[1]);
      }
    }

    const sampleCfg: GateConfig = {
      key: "k".repeat(32),
      shell: "example.com",
      content: "example-pages.com",
      https: true,
      open: false,
      idp: { org: { authorize: "https://idp.example.com/auth", client: "c", scope: "openid" } },
      oauth: true,
    };

    const refs: Record<CodeRef, unknown> = {
      "gate.SIGN_IN_DAYS": SIGN_IN_DAYS,
      "gate.SIGN_IN_DAYS_MAX": SIGN_IN_DAYS_MAX,
      "gate.GRANT_DAYS": GRANT_DAYS,
      "gate.openPaths": [...GATE_OPEN_PATHS],
      "gate.accessOpen": [...ACCESS_OPEN],
      "gate.cookies": GATE_COOKIES(sampleCfg),
    };

    return { routes, bindings, tables, machines, refs };
  })();
  return cachedIndex;
}

function normalizePath(p: string): string {
  const clean = p.split("?")[0].replace(/\/+$/, "") || "/";
  return clean.replace(/:\w+/g, "x").replace(/<[^>]+>/g, "x");
}

function routeExists(routes: readonly { method: string; path: string }[], method: string, path: string): boolean {
  const sample = normalizePath(path);
  return routes.some((r) => {
    const methodOk = r.method == method || (method == "WS" && (r.method == "GET" || r.method == "WS"));
    if (!methodOk) return false;
    return pathPattern(r.path).re.test(sample);
  });
}

// ---------------------------------------------------------------- Layer 2: real gate() + machine oracles

const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const GATE_PORT: GatePort = {
  hmac: (key, text) => b64u(createHmac("sha256", key).update(text).digest()),
  sha256: (text) => b64u(createHash("sha256").update(text).digest()),
  enc: (text) => b64u(Buffer.from(text, "utf8")),
  dec: (text) => {
    try {
      return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return null;
    }
  },
};

const EDGE_KEY = "demo-verify-edge-key-0123456789abcdef";

function gateConfigFor(combo: Readonly<Record<string, string>>): GateConfig {
  const mode = combo.mode ?? "sso";
  const same = combo.site == "same";
  return {
    key: EDGE_KEY,
    shell: "example.com",
    content: same ? "pages.example.com" : "example-pages.com",
    https: true,
    open: mode == "oauth",
    idp:
      mode == "access"
        ? "access"
        : {
            google: { authorize: "https://idp.example.com/authorize", client: "cid", scope: "openid email profile" },
          },
    oauth: true,
  };
}

async function runGateOracle(hop: HopStep, combo: Readonly<Record<string, string>>, holds: ReadonlySet<string>): Promise<string | null> {
  if (!hop.gateExpect || !hop.path) return null;
  const cfg = gateConfigFor(combo);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const exp = nowSec + 3600;

  const cookies: Record<string, string[]> = {};
  const headers: Record<string, string | undefined> = {};
  if (hop.secFetchDest) headers["sec-fetch-dest"] = hop.secFetchDest;

  const mode = combo.mode ?? "sso";
  const same = combo.site == "same";
  const host = hop.host == "accept" ? `accept.${cfg.content}` : hop.host == "content" ? `doc1.${cfg.content}` : cfg.shell;

  let accessIdentity: GateReq["access"] = null;
  const fromBrowser = hop.from == "sshell" || hop.from == "sframe";
  if (fromBrowser && holds.has("sshell0")) {
    if (mode == "access") {
      accessIdentity = { p: "access", sub: "ada", email: "ada@example.com", name: "Ada", e: exp };
    } else {
      cookies["__Host-erga"] = [
        await seal(GATE_PORT, EDGE_KEY, "s", { p: "google", sub: "ada", email: "ada@example.com", name: "Ada", i: nowMs }, exp),
      ];
    }
  }
  if (fromBrowser && (holds.has("sframe0") || (same && holds.has("sshell2")))) {
    cookies["member"] = [await seal(GATE_PORT, EDGE_KEY, "m", {}, exp)];
  }
  if (fromBrowser && !same && holds.has("sshell2")) {
    cookies["__Host-member"] = [await seal(GATE_PORT, EDGE_KEY, "m", {}, exp)];
  }
  if (
    hop.authHeader == "agent" ||
    (hop.authHeader != "none" && !fromBrowser && (hop.from == "sbridge" || hop.wire == "bridge" || hop.wire == "yjs") && holds.has("smcp0"))
  ) {
    const tok = await seal(GATE_PORT, EDGE_KEY, "a", { p: "google", sub: "ada", g: "g7" }, exp);
    headers.authorization = `Bearer ${tok}`;
  }

  const req: GateReq = {
    method: hop.method == "WS" ? "GET" : (hop.method ?? "GET"),
    host,
    path: normalizePath(hop.path),
    query: {},
    headers,
    cookies,
    id: "req-verify-1",
    now: nowMs,
    access: accessIdentity,
  };

  const ans = await gate(req, cfg, GATE_PORT);
  const want = hop.gateExpect;
  if (ans.do != want.do) {
    const gotDetail = ans.do == "respond" ? `respond(${ans.status})` : `${ans.do}(${ans.do == "forward" ? ans.caller.kind : ""})`;
    return `gate(${req.method} ${req.path}, ${JSON.stringify(combo)}) returned ${gotDetail}, expected ${want.do}${want.status ? `(${want.status})` : ""}`;
  }
  if (want.status != null && ans.do == "respond" && ans.status != want.status) {
    return `gate(${req.method} ${req.path}) returned HTTP ${ans.status}, expected ${want.status}`;
  }
  if (want.caller != null && ans.do == "forward" && ans.caller.kind != want.caller) {
    return `gate(${req.method} ${req.path}) forwarded caller "${ans.caller.kind}", expected "${want.caller}"`;
  }
  return null;
}

function runMachineOracle(mc: MachineCheck): string | null {
  if (mc.machine == "updateStep") {
    const res = updateStep(mc.state as unknown as UpdateState, mc.event as unknown as UpdateEvent);
    if (mc.expectAt && res.state.at != mc.expectAt) {
      return `updateStep produced state "${res.state.at}", expected "${mc.expectAt}"`;
    }
    return null;
  }
  if (mc.machine == "bridgeStep") {
    const st = (Object.keys(mc.state).length ? mc.state : EMPTY_BRIDGES) as unknown as BridgeState;
    const res = bridgeStep(st, mc.event as unknown as BridgeEvent);
    if (mc.expectOk != null && res.ok != mc.expectOk) {
      return `bridgeStep returned ok=${res.ok}, expected ${mc.expectOk}`;
    }
    return null;
  }
  if (mc.machine == "blockedStep") {
    const res = blockedStep(mc.state as unknown as BlockedState, mc.event as unknown as BlockedEvent);
    if (mc.expectAt && res.state.at != mc.expectAt) {
      return `blockedStep produced state "${res.state.at}", expected "${mc.expectAt}"`;
    }
    if (mc.expectExpand != null && res.expand != mc.expectExpand) {
      return `blockedStep returned expand=${res.expand}, expected ${mc.expectExpand}`;
    }
    return null;
  }
  if (mc.machine == "threadEventStep") {
    const s = mc.state as { thread: string | null };
    const e = mc.event as { t: "sync" | "agent" | "log"; thread?: string };
    const res = threadEventStep(s.thread, e as Parameters<typeof threadEventStep>[1]);
    if (mc.expectAt && res.effect.action != mc.expectAt) {
      return `threadEventStep returned action="${res.effect.action}", expected "${mc.expectAt}"`;
    }
    if (mc.expectThread !== undefined && res.thread != mc.expectThread) {
      return `threadEventStep returned thread=${res.thread}, expected ${mc.expectThread}`;
    }
    return null;
  }
  return `Unknown state machine "${mc.machine}"`;
}

// ---------------------------------------------------------------- main verifier (Layers 1-4)

export async function verifyDemoSpec(spec: DemoSpec, opts: { trace?: boolean } = {}): Promise<VerificationLedger> {
  const idx = await loadCodebaseIndex();
  const issues: VerificationIssue[] = [];
  const plannedItems: string[] = [];
  const resolvedConstants: Record<string, unknown> = {};

  const push = (layer: VerificationIssue["layer"], code: string, where: string, message: string) =>
    issues.push({ layer, code, where, message });

  const checkPlanned = (where: string, planned?: boolean) => {
    if (!planned) return false;
    plannedItems.push(where);
    if (spec.status == "verified") {
      push("L1", "PLANNED_IN_VERIFIED", where, `status is "verified" so planned: true is forbidden`);
    }
    return true;
  };

  // ---------------- Layer 1: Static Codebase Grounding ----------------
  for (const [id, node] of Object.entries(spec.nodes)) {
    const isPlanned = checkPlanned(`node:${id}`, node.planned || node.bindsTo?.planned);
    if (!isPlanned && node.bindsTo) {
      for (const f of node.bindsTo.files ?? []) {
        if (!existsSync(join(ROOT, f))) push("L1", "MISSING_FILE", `node:${id}`, `bound file "${f}" does not exist`);
      }
      for (const ex of node.bindsTo.exports ?? []) {
        const full = join(ROOT, ex.file);
        if (!existsSync(full)) {
          push("L1", "MISSING_FILE", `node:${id}`, `export file "${ex.file}" does not exist`);
        } else if (!new RegExp(`\\bexport\\b[^\\n]*\\b${ex.symbol}\\b`).test(readFileSync(full, "utf8"))) {
          push("L1", "MISSING_EXPORT", `node:${id}`, `symbol "${ex.symbol}" is not exported from "${ex.file}"`);
        }
      }
      for (const b of node.bindsTo.bindings ?? []) {
        if (!idx.bindings.has(b)) push("L1", "MISSING_BINDING", `node:${id}`, `Worker binding "${b}" not found in cloudflare.config.ts`);
      }
      for (const t of node.bindsTo.tables ?? []) {
        if (!idx.tables.has(t)) push("L1", "MISSING_TABLE", `node:${id}`, `D1 table "${t}" not found in server/migrations/*.sql`);
      }
      for (const m of node.bindsTo.machines ?? []) {
        if (!idx.machines.has(m)) push("L1", "MISSING_MACHINE", `node:${id}`, `state machine "${m}" not found in repo`);
      }
    }

    // Check openPaths against gate/core.ts exact allowlist
    if (node.openPaths) {
      if (isRefValue(node.openPaths)) {
        resolvedConstants[`${id}.openPaths`] = idx.refs[node.openPaths.$ref];
      } else {
        for (const p of node.openPaths) {
          if (p.includes("*")) {
            const matchesPattern = p == "/.well-known/oauth-*";
            if (!matchesPattern) {
              push("L1", "OVERBROAD_OPEN_PATH", `node:${id}`, `wildcard open path "${p}" is broader than gate/core.ts`);
            }
            continue;
          }
          const bare = p.replace(/^accept\.<content>/, "");
          if (!GATE_OPEN_PATHS.includes(bare)) {
            push("L1", "INVALID_OPEN_PATH", `node:${id}`, `"${p}" is not an unauthenticated open path in gate/core.ts`);
          }
        }
        // Ensure /oauth/register is not silently forgotten when /oauth/token is shown
        if (node.openPaths.includes("/oauth/token") && !node.openPaths.includes("/oauth/register")) {
          push(
            "L1",
            "MISSING_OPEN_PATH",
            `node:${id}`,
            `Gate openPaths includes /oauth/token but omits /oauth/register (gate/core.ts PATTERNS.forms)`
          );
        }
      }
    }

    // Check constants ($ref resolved from code, or literal drift detection)
    for (const [k, v] of Object.entries(node.constants ?? {})) {
      if (isRefValue(v)) {
        resolvedConstants[`${id}.${k}`] = idx.refs[v.$ref];
      } else {
        resolvedConstants[`${id}.${k}`] = v;
        if (k == "shellCookieDays" && v != SIGN_IN_DAYS) {
          push("L1", "CONSTANT_DRIFT", `node:${id}.${k}`, `shellCookieDays=${v} contradicts gate/core.ts SIGN_IN_DAYS=${SIGN_IN_DAYS}`);
        }
        if (k == "grantDays" && v != GRANT_DAYS) {
          push("L1", "CONSTANT_DRIFT", `node:${id}.${k}`, `grantDays=${v} contradicts server/identity/grants.ts GRANT_DAYS=${GRANT_DAYS}`);
        }
      }
    }
  }

  for (const [wid, wire] of Object.entries(spec.wires)) {
    checkPlanned(`wire:${wid}`, wire.planned);
    if (!spec.nodes[wire.from]) push("L1", "UNKNOWN_WIRE_NODE", `wire:${wid}`, `wire from "${wire.from}" is not a declared node`);
    if (!spec.nodes[wire.to]) push("L1", "UNKNOWN_WIRE_NODE", `wire:${wid}`, `wire to "${wire.to}" is not a declared node`);
  }

  // ---------------- Layer 2 + Layer 3 across EVERY valid toggle combo ----------------
  const combos = expandMatrix(spec.matrix);
  let hopsChecked = 0;
  let gateChecks = 0;
  let machineChecks = 0;
  let frameChecks = 0;
  const checkedStaticHops = new Set<string>();

  for (const combo of combos) {
    const comboTag = Object.entries(combo)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    let life = initialLifecycle(spec.nodes);

    const checkStepList = async (sceneId: string, steps: readonly (HopStep | StateStep | ParallelStep)[]) => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const where = `scene=${sceneId}[${i}](${comboTag})`;

        if (step.kind == "parallel") {
          // Each concurrent branch is checked from the pre-branch state; effects merge after all branches complete.
          let merged = life;
          for (let b = 0; b < step.branches.length; b++) {
            const saved = life;
            life = saved;
            await checkStepList(`${sceneId}.par${b}`, resolveSteps(step.branches[b], combo));
            merged = {
              nodeStates: { ...merged.nodeStates, ...life.nodeStates },
              holds: new Set([...merged.holds, ...life.holds]),
            };
          }
          life = merged;
          continue;
        }

        if (step.kind == "state") {
          checkPlanned(`state:${sceneId}[${i}]`, step.planned);
          if (step.machineCheck) {
            machineChecks++;
            const err = runMachineOracle(step.machineCheck);
            if (err) push("L2", "MACHINE_ORACLE", where, err);
          }
          const res = lifecycleStep(life, { on: "state", step, where }, spec.nodes, spec.wires);
          life = res.state;
          for (const e of res.errors) push("L3", "LIFECYCLE", where, e);
          continue;
        }

        // HopStep
        hopsChecked++;
        const hopKey = `${sceneId}:${i}:${step.method ?? ""}:${step.path ?? ""}:${step.label}`;
        const isHopPlanned = checkPlanned(`hop:${sceneId}[${i}]:${step.label}`, step.planned);

        // L1 route check (once per unique static hop)
        if (!isHopPlanned && (step.proto == "http" || step.proto == "ws") && step.path && !checkedStaticHops.has(hopKey)) {
          checkedStaticHops.add(hopKey);
          const method = step.proto == "ws" ? "WS" : (step.method ?? "GET");
          if (!routeExists(idx.routes, method, step.path)) {
            push("L1", "MISSING_ROUTE", `scene=${sceneId}[${i}]`, `route "${method} ${step.path}" not found in Erga route tables`);
          }
        }

        // L3 lifecycle & credential preconditions (before applying hop effects)
        const lifeRes = lifecycleStep(life, { on: "hop", hop: step, where }, spec.nodes, spec.wires);
        for (const e of lifeRes.errors) push("L3", "LIFECYCLE", where, e);

        // L2 live gate() oracle (using credentials held BEFORE this hop completes!)
        if (!isHopPlanned && step.gateExpect) {
          gateChecks++;
          const gateErr = await runGateOracle(step, combo, life.holds);
          if (gateErr) push("L2", "GATE_ORACLE", where, gateErr);
        }

        // L2 bridge wire schema oracle
        if (!isHopPlanned && step.bridgeFrame) {
          frameChecks++;
          const raw = JSON.stringify(step.bridgeFrame.frame);
          const ok = step.bridgeFrame.direction == "fromBridge" ? parseFromBridge(raw) : parseToBridge(raw);
          if (!ok) {
            push("L2", "BRIDGE_SCHEMA", where, `${step.bridgeFrame.direction} frame failed shared/bridge-schema.ts decode: ${raw}`);
          }
        }

        // L2 pure *Step() state machine oracle
        if (!isHopPlanned && step.machineCheck) {
          machineChecks++;
          const err = runMachineOracle(step.machineCheck);
          if (err) push("L2", "MACHINE_ORACLE", where, err);
        }

        life = lifeRes.state;
      }
    };

    for (const scene of spec.scenes) {
      await checkStepList(scene.id, resolveSteps(scene.steps, combo));
    }
  }

  // ---------------- Layer 4: Real Execution Trace Conformance ----------------
  let tracesChecked = 0;
  let elidedCount = 0;
  for (const scene of spec.scenes) {
    elidedCount += scene.elided?.length ?? 0;
    if (opts.trace === false || !scene.traceId) continue;
    tracesChecked++;
    // Match trace against the combo matching the traceId suffix (e.g. device vs pkce) or first valid combo
    const combo =
      combos.find((c) => scene.traceId!.includes("device") && c.bridgeAuth == "device") ??
      combos.find((c) => scene.traceId!.includes("pkce") && c.bridgeAuth == "pkce") ??
      combos[0] ??
      {};
    const traceEvents = await captureErgaTrace(scene.traceId);
    const resolved = resolveSteps(scene.steps, combo);
    const conf = checkTraceConformance(scene, resolved, traceEvents, spec.projection);
    for (const e of conf.errors) push("L4", "TRACE_CONFORMANCE", `scene=${scene.id}`, e);
  }

  // Deduplicate plannedItems across combos
  const uniquePlanned = [...new Set(plannedItems)];

  return {
    id: spec.id,
    status: spec.status,
    ok: issues.length == 0,
    combosChecked: combos.length,
    hopsChecked,
    gateChecks,
    machineChecks,
    frameChecks,
    tracesChecked,
    plannedCount: uniquePlanned.length,
    elidedCount,
    resolvedConstants,
    plannedItems: uniquePlanned,
    issues,
  };
}
