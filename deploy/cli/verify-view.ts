// The ops page's part for the verify suite (`bun erga verify`, dev/verify/suite.ts): pure, the facts in and HTML out
// (ops-view.ts puts it in the page, at #verify). It answers at a glance how much setup there is to do, and what has
// passed: one line on top; each prerequisite with its state and what to do; each unit with its state (ready, or blocked
// by what), its last run (when, how long, pass and fail by browser), and a Run button; each unit that is kept in the
// accounts (`--keep`): since when, its hosts, what each hour of it costs, with an Update and a Remove button; and what
// a run left in the accounts, with a Remove button. #verify/<unit> adds the unit's last run: each check in each
// browser, and the links to its log and its record. The buttons run `bun erga verify ...` (ops-page.ts, POST
// /api/verify), after a question that says what the run costs.

import { esc } from "../../shared/html";
import { timeAgo } from "../../shared/time";
import type { Prereq } from "../../dev/verify/prereqs";
import {
  headline,
  type KeptUnits,
  leftOf,
  matrix,
  neededBy,
  type Result,
  type RunRecord,
  readiness,
  type State,
  tally,
  took,
  type Unit,
  units,
} from "../../dev/verify/suite";

export interface VerifyFacts {
  /** The last look at the prerequisites and the accounts; null: none yet. */
  state: State | null;
  /** The runs' records, newest first, each with its result. */
  runs: (RunRecord & { result: Result })[];
  /** The units that are kept in the accounts (.erga/verify/kept.json). */
  kept: KeptUnits;
  /** The command that this page runs now ("": none), and why its last one failed. */
  busy: string;
  error: string;
}

const lastOf = (v: VerifyFacts, unit: string) => v.runs.find((r) => r.unit == unit);
const results = (v: VerifyFacts) => Object.fromEntries(units().map((u) => [u.id, lastOf(v, u.id)?.result]));
/** The command that runs now: the page's own, or a run's from any terminal. */
const busyWith = (v: VerifyFacts) => v.busy || (v.runs.find((r) => r.result == "running")?.command ?? "");

/** Text with its addresses as links. */
const linked = (text: string) =>
  text
    .split(/(https:\/\/[^\s"<>()]*[^\s"<>().,:;])/)
    .map((part, i) => (i % 2 ? `<a href="${esc(part)}" target="_blank" rel="noreferrer">${esc(part)}</a>` : esc(part)))
    .join("");

const button = (label: string, attrs: string, block: string | null, quiet = false) =>
  `<span class="tip"${block ? ` title="${esc(block)}"` : ""}><button class="btn${quiet ? " quiet" : ""}" type="button" ${attrs}${block ? " disabled" : ""}>${label}</button></span>`;

/** The suite's entry in the sidebar: how much setup is done, and one word for the runs. */
export function verifySide(v: VerifyFacts, selected: boolean): string {
  const needed = (v.state?.prereqs ?? []).filter((p) => neededBy(p.id).length);
  const done = needed.filter((p) => p.done).length;
  const last = Object.values(results(v));
  const left = leftOf(v.state?.left ?? [], v.kept).length;
  const kept = Object.keys(v.kept).length;
  const word = busyWith(v)
    ? `<span class="g-state deploying">running</span>`
    : left
      ? `<span class="g-state failed">${left} left</span>`
      : last.some((r) => r == "failed" || r == "stopped")
        ? `<span class="g-state failed">${last.filter((r) => r == "failed" || r == "stopped").length} failed</span>`
        : last.some((r) => r == "passed")
          ? `<span class="g-state">${last.filter((r) => r == "passed").length} passed</span>`
          : "";
  const light = !v.state ? "" : done == needed.length ? "ok" : "stale";
  const setup = v.state ? `${done} of ${needed.length} set up` : "not checked";
  // (A kept setting costs money by the hour: the entry always says it.)
  const keeps = kept ? `<span class="g-state">${kept} kept</span>` : "";
  return `<h2 class="side-head side-more">Real platforms</h2><ul class="instances"><li><a class="group${selected ? " sel" : ""}" href="#verify"${selected ? ' aria-current="true"' : ""}><span class="host"><i class="light ${light}"></i><span>Verify suite</span></span><span class="tracks"><span>${setup}</span>${keeps}${word}</span></a></li></ul>`;
}

/** A prerequisite's row: its light (green: done; orange: to do; grey: to do, and optional), what the check saw, and what to do. */
function prereqRow(p: Prereq): string {
  const who = neededBy(p.id);
  const cls = p.done ? "ok" : who.length ? "todo" : "opt";
  const todo = p.done ? "" : `<span class="v-do"><b>Do:</b> ${linked(p.todo)}</span>`;
  return `<div class="v-row ${cls}" data-prereq="${p.id}"><i class="light ${p.done ? "ok" : who.length ? "stale" : ""}"></i><div class="v-what"><b>${esc(p.title)}</b><span>${esc(p.detail)}</span>${todo}</div><span class="v-for" title="${who.length ? "The settings and browsers that need it" : "No setting needs it"}">${who.length ? esc(who.join(" ")) : "optional"}</span><span class="v-state">${p.done ? "done" : "to do"}</span></div>`;
}

/** A unit's state in words, and why its Run button is off (null: it is on). */
function stateOf(u: Unit, v: VerifyFacts, now: number): { cls: string; text: string; block: string | null } {
  if (!v.state) return { cls: "blocked", text: "Not checked yet", block: "Check the prerequisites first." };
  const r = readiness(u, v.state.prereqs);
  const titles = (ps: Prereq[]) => ps.map((p) => p.title).join("; ");
  if (r.at == "blocked") return { cls: "blocked", text: `Blocked by: ${titles(r.by)}`, block: `Blocked by: ${titles(r.by)}` };
  const kept = v.kept[u.id];
  if (kept)
    return {
      cls: "kept",
      text: `Kept since ${timeAgo(Date.parse(kept.since) || now, now)}: Update deploys its code again`,
      block: "It is kept: Update it, or Remove it first.",
    };
  const left = leftOf(v.state.left, v.kept).filter((l) => l.unit == u.id);
  if (left.length)
    return {
      cls: "blocked",
      text: `Not removed yet: ${left.map((l) => l.name).join(", ")}`,
      block: "Remove what the last run left first.",
    };
  return { cls: "ready", text: r.weak.length ? `Ready. A check fails until: ${titles(r.weak)}` : "Ready", block: null };
}

const chips = (r: RunRecord) =>
  tally(r.rows)
    .map(
      (t) =>
        `<span class="chip ${t.fail ? "bad" : "ok"}" title="${esc(`${t.browser}: ${t.pass} pass, ${t.fail} fail, ${t.skipped} not run`)}">${esc(t.browser)} ${t.pass}/${t.pass + t.fail}</span>`
    )
    .join("");
const seconds = (r: RunRecord) => r.steps.reduce((n, s) => n + (s.seconds ?? 0), 0);
const at = (r: RunRecord, now: number) => timeAgo(Date.parse(r.started) || now, now);
/** A run in one line: its result, when, how long (while it runs: its step). */
function runWords(r: RunRecord & { result: Result }, now: number): string {
  if (r.result == "running") {
    const s = r.steps.at(-1);
    return `runs${s ? `: ${s.step}, ${took(Math.max(0, (now - Date.parse(s.started)) / 1000))}` : ""}`;
  }
  return `${r.result} ${at(r, now)} · ${took(seconds(r))}`;
}
const links = (r: RunRecord) =>
  `<a href="/verify/log/${esc(r.id)}" target="_blank">log</a> · <a href="/verify/run/${esc(r.id)}" target="_blank">record</a>`;

function unitRow(u: Unit, v: VerifyFacts, chosen: boolean, now: number): string {
  const st = stateOf(u, v, now);
  const last = lastOf(v, u.id);
  const busy = busyWith(v);
  const mine = last?.result == "running";
  const note = `${u.cost} It makes only resources named erga-verify-..., and removes them at its end.`;
  const wait = busy ? `Another command runs: ${busy}. Wait for it to end.` : null;
  const run = mine
    ? button(`<i class="spin" aria-hidden="true"></i>Running…`, 'aria-busy="true"', "It runs now.")
    : v.kept[u.id]
      ? button("Update", `data-verify="update" data-unit="${u.id}" aria-label="${esc(`Update setting ${u.id}`)}"`, wait)
      : button(
          "Run",
          `data-verify="run" data-unit="${u.id}" data-ask="${esc(`Run setting ${u.id}: ${u.title}?`)}" data-note="${esc(note)}" data-go="${esc(`Run ${u.id}`)}" aria-label="${esc(`Run setting ${u.id}`)}"`,
          st.block ?? wait
        );
  const lastHtml = last
    ? `<span class="u-res ${last.result}">${esc(runWords(last, now))}</span><span class="chips">${chips(last)}</span>`
    : `<span class="u-res">no run yet</span>`;
  return `<div class="u-row${chosen ? " sel" : ""}" data-unit="${u.id}"><a class="u-id" href="#verify/${u.id}">${esc(u.id)}</a><div class="u-what"><a href="#verify/${u.id}"><b>${esc(u.title)}</b></a><span class="u-state ${st.cls}">${esc(st.text)}</span></div><div class="u-last">${lastHtml}</div><span class="u-act">${run}</span></div>`;
}

/** A unit's last run: its steps, each check in each browser (a failed check with its note), and its earlier runs. */
function detail(u: Unit, v: VerifyFacts, now: number): string {
  const mine = v.runs.filter((r) => r.unit == u.id);
  const r = mine[0];
  const head = `<h3 class="c-head" id="v-detail">Setting ${esc(u.id)}: ${esc(u.title)}</h3>`;
  const cost = `<p class="note">A run costs: ${esc(u.cost)}</p>`;
  if (!r) return `${head}<p class="note">No run yet.</p>${cost}`;
  const steps = r.steps
    .map((s) => `${s.step} ${s.seconds == null ? "runs" : took(s.seconds)}${s.code ? ` (exit ${s.code})` : ""}`)
    .join(" · ");
  const left = r.left.length ? `<p class="note bad">Left in the accounts: ${esc(r.left.join(", "))}</p>` : "";
  const m = matrix(r.rows);
  const cell = (row: { ok: boolean | null; note: string } | undefined) =>
    !row
      ? `<td></td>`
      : `<td class="${row.ok == null ? "skip" : row.ok ? "ok" : "bad"}" title="${esc(row.note)}">${row.ok == null ? "not run" : row.ok ? "pass" : "FAIL"}</td>`;
  const table = m.checks.length
    ? `<table class="matrix"><thead><tr><th>Check</th>${m.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${m.checks
        .map(({ check, cells }) => {
          const notes = m.columns
            .filter((c) => cells[c]?.ok === false && cells[c].note)
            .map((c) => `<span class="m-note"><b>${esc(c)}:</b> ${esc(cells[c].note.slice(0, 400))}</span>`)
            .join("");
          return `<tr><td class="m-check">${esc(check)}${notes}</td>${m.columns.map((c) => cell(cells[c])).join("")}</tr>`;
        })
        .join("")}</tbody></table>`
    : `<p class="note">${r.result == "running" ? "The checks have not run yet." : "This run has no check: its deploy failed, or it stopped. The log says why."}</p>`;
  const earlier = mine
    .slice(1, 8)
    .map(
      (e) =>
        `<li><span class="u-res ${e.result}">${esc(runWords(e, now))}</span><span class="chips">${chips(e)}</span><span>${links(e)}</span></li>`
    )
    .join("");
  return `${head}<p class="v-run"><span class="u-res ${r.result}">${esc(runWords(r, now))}</span><span>${esc(steps)}</span><span>commit <code>${esc(r.commit.slice(0, 7))}</code></span><span>${esc(r.browsers.join(", "))}</span><span>from ${r.from == "page" ? "this page" : "a terminal"}</span><span>${links(r)}</span></p>${cost}${left}${table}${earlier ? `<h3 class="c-head">Earlier runs of setting ${esc(u.id)}</h3><ul class="v-earlier">${earlier}</ul>` : ""}`;
}

const removeButton = (unit: string, ask: string, v: VerifyFacts) => {
  const busy = busyWith(v);
  return button(
    `Remove ${esc(unit)}`,
    `data-verify="remove" data-unit="${esc(unit)}" data-ask="${esc(ask)}" data-note="${esc(`bun erga verify remove ${unit}. It removes only the resources named erga-verify-... of this setting.`)}" data-go="${esc(`Remove ${unit}`)}"`,
    busy ? `Another command runs: ${busy}. Wait for it to end.` : null,
    true
  );
};

/**
 * The units that are kept in the accounts (--keep): each since when, with its hosts, what each hour of it costs, how
 * many resources the last look saw of it, and its Remove button. (Its Update button is in its row of the settings.)
 */
function keptUnits(v: VerifyFacts, now: number): string {
  const rows = units()
    .filter((u) => v.kept[u.id])
    .map((u) => {
      const k = v.kept[u.id];
      const there = (v.state?.left ?? []).filter((l) => l.unit == u.id).length;
      const hosts = k.hosts.map((h) => `<code>${esc(h)}</code>`).join(" ");
      return `<div class="v-row kept" data-kept="${u.id}"><i class="light stale"></i><div class="v-what"><b>Setting ${esc(u.id)}: kept since ${esc(timeAgo(Date.parse(k.since) || now, now))}</b><span>${hosts} · since ${esc(k.since)} · ${there} resources in the accounts</span><span class="v-do"><b>Cost:</b> ${esc(u.keep)}</span></div><span class="v-for"></span><span class="u-act">${removeButton(u.id, `Remove setting ${u.id}, which is kept?`, v)}</span></div>`;
    })
    .join("");
  return rows ? `<h3 class="c-head">Kept in the accounts</h3><div class="v-list">${rows}</div>` : "";
}

/** What the runs left in the accounts (not a kept unit's): each resource, and one Remove button for each unit. */
function leftovers(v: VerifyFacts): string {
  const s = v.state;
  const left = leftOf(s?.left ?? [], v.kept);
  if (!s || (!left.length && !s.unread.length))
    return `<p class="note">Nothing of the suite is ${Object.keys(v.kept).length ? "left in the accounts: only what is kept" : "in the accounts"}.</p>`;
  const seen = new Set<string>();
  const rows = left
    .map((l) => {
      const first = l.unit != null && !seen.has(l.unit);
      if (l.unit) seen.add(l.unit);
      const act = !l.unit
        ? `<span class="v-for" title="No setting made it: the suite does not remove it.">not the suite's</span>`
        : first
          ? removeButton(l.unit, `Remove what setting ${l.unit} left in the accounts?`, v)
          : "";
      return `<div class="v-row left"><i class="light bad"></i><div class="v-what"><b><code>${esc(l.name)}</code></b><span>${esc(l.kind)}${l.unit ? `, of setting ${esc(l.unit)}` : ""}</span></div><span class="v-for"></span><span class="u-act">${act}</span></div>`;
    })
    .join("");
  const unread = s.unread.map((u) => `<p class="note">${esc(u)}</p>`).join("");
  return `${rows ? `<div class="v-list">${rows}</div>` : ""}${unread}`;
}

/** The suite's page. `unit`: the unit whose last run shows under the list. */
export function verifyHtml(v: VerifyFacts, unit: string, now: number): string {
  const all = units();
  const chosen = all.find((u) => u.id == unit) ?? null;
  const busy = busyWith(v);
  const running = v.runs.find((r) => r.result == "running");
  const check = button("Check again", 'data-verify="check"', busy ? `Another command runs: ${busy}. Wait for it to end.` : null, true);
  const job = running
    ? `<div class="job running"><i class="light"></i><code>${esc(running.command)}</code><span>setting ${esc(running.unit)} ${esc(runWords(running, now))} · <a href="/verify/log/${esc(running.id)}" target="_blank">log</a></span></div>`
    : v.busy
      ? `<div class="job running"><i class="light"></i><code>${esc(v.busy)}</code><span>runs · from this page</span></div>`
      : `<div class="job none v-checked"><span>${v.state ? `Checked ${esc(timeAgo(Date.parse(v.state.at) || now, now))}.` : "The prerequisites are not checked yet."}</span>${check}</div>`;
  const error = `${v.error ? `<p class="note bad failed">${esc(v.error)}</p>` : ""}<p class="err" id="verify-err" role="alert"></p>`;
  // What a setting or a browser needs and is not done comes first; then what is done; then what is optional.
  const order = (p: Prereq) => (!neededBy(p.id).length ? 2 : p.done ? 1 : 0);
  const prereqs = v.state
    ? `<div class="v-list">${[0, 1, 2].flatMap((n) => v.state!.prereqs.filter((p) => order(p) == n).map(prereqRow)).join("")}</div>`
    : `<p class="note">Check again, or run <code>bun erga verify</code>: it checks each prerequisite, and deploys nothing.</p>`;
  const confirm = `<div class="confirm" id="verify-confirm" popover><p data-s="ask"></p><p class="soft" data-s="note"></p><div class="acts"><button class="btn" type="button" data-go>Run</button><button class="btn quiet" type="button" popovertarget="verify-confirm" popovertargetaction="hide">Cancel</button></div><p class="err" role="alert"></p></div>`;
  return `<section class="main verify" data-tab="verify"><h2 class="title">Verify suite</h2><p class="tracks-line">Each setting deploys a fresh Erga behind the gate to real accounts, checks it in real browsers, and removes it: <code>bun erga verify</code>. With <code>--keep</code> it stays, and <code>bun erga verify update</code> deploys only the code again. It is no part of <code>bun run test</code>.</p>${job}${error}<p class="v-head">${esc(headline(v.state, results(v), v.kept))}</p><h3 class="c-head">Prerequisites</h3>${prereqs}<h3 class="c-head">Settings</h3><div class="v-list units">${all.map((u) => unitRow(u, v, u == chosen, now)).join("")}</div>${chosen ? detail(chosen, v, now) : ""}${keptUnits(v, now)}<h3 class="c-head">Left in the accounts</h3>${leftovers(v)}${confirm}</section>`;
}
