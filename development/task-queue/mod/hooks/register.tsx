import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'

// The task queue (development/task-queue in the repo) stays the source of
// truth and the browser board; this mod is its front end in Claude Code:
//   - task_create: registers a task and starts a worker in its worktree, in one call (unless its
//     dependencies hold it: then task_start starts it once they've merged); task_deps changes them
//   - task_log / task_preview / task_screenshot / task_unscreenshot / task_done / task_fail: the worker's reports;
//     task_continue: the worker, after fixing what stopped its merge (needs-agent)
//   - one agent per task until it merges: task_create and task_start record the worker's agent id on the task
//   - the worker agent type, its instructions built in
//   - the workflow rule in the main agent's system prompt
//   - a Tasks pane (/tasks) with Open / Merge / Discard, a status entry, toasts
//     (ready to merge, merging, needs agent, merged, merge failed, failed, unblocked, blocked)
// It does nothing in a repo without development/task-queue/server.ts.

const QUEUE = 'http://127.0.0.1:4700'
const PANE = 'task-queue'
const WORKER = 'task-queue:worker'

const tasks = atom({ plugin: 'task-queue', key: 'tasks' } as const, [])
const isOnline = atom({ plugin: 'task-queue', key: 'isOnline' } as const, false)
const armed = atom({ plugin: 'task-queue', key: 'armed' } as const, null)

const WORKFLOW = `# The task queue

This repo tracks work in a task queue (board: http://localhost:4700). When the user asks for a change to the repo,
your first and only step is to call mcp__task-queue__task_create with a short imperative title and a short, clear description
of the ask: a few plain sentences on what the user wants, plus only the context the worker can't find itself, not a
wall of text (the board shows it as the ask). That registers the task, makes its branch and
worktree, and starts a background worker that does, tests and reports the work. Then tell the user in one line that
it's task #<id> on the board, and stay free for their next instruction: don't implement, test or merge it yourself,
and don't wait on the worker. Several tasks may run at once. When a worker reports back, relay its URL and summary in
a sentence or two, in ASD-STE100 (Simplified Technical English). The user merges from the board or the Tasks pane (/tasks).

Watch the queue for the whole session, so you hear when each task changes state without the user telling you: at the
start of the session, run \`development/task-queue/tq watch --state /tmp/tq-watch-<a name for this session>.json\` under
the Monitor tool (timeout_ms at the maximum), and re-arm it with the same command whenever it expires (--state
reports what changed in between). It prints one line per status change ("#3 ready to merge: title", "#3 merged:
title", "#4 failed: title: why", "#5 merge failed, back to ready to merge: title: why", "#6 needs agent: title: why
(agent ID)") and nothing else. Act on each without being asked: relay a ready or failed task the worker hasn't
already reported, say why a merge failed, and when a task merges, start any task it unblocks (below).

One agent per task, from start until merge. task_create and task_start record the worker's agent id on the task
(the queue's agent field). A worker that finishes stays that task's agent until the task merges. When a merge needs
work, the queue stops it, puts the worktree back on the branch's last commit, and sets the task to needs-agent:
a conflict, uncommitted changes, a failed check, or a step that timed out. The watch prints "#6 needs agent: title:
conflicts merging origin/staging: README.md (agent a1b2c3)". Then, without being asked: tell the user in a line, and
wake that task's own agent with SendMessage (to the agent id in the line, or tq get <id>'s agent), saying what
stopped the merge (tq get <id>: error, needsAgent.output). The agent fixes it in the worktree, tests under a time
limit, commits, and calls task_continue; the merge then runs again by itself. Only if that agent is gone (a new
session, or SendMessage fails), start a new task-queue:worker on the task with the Agent tool, its prompt holding
the task's ask, summary and log (tq get <id>), and record its agent id with \`development/task-queue/tq agent <id>
<agentId>\`. Never merge or resolve it yourself.

Dependencies: when you split work into several tasks, say how they depend on each other, so the queue enforces it.
Pass after: [ids] to task_create when a task truly needs another one merged first (it stays queued, with no worker,
until then); pass mergeAfter: [ids] when tasks can be built in parallel against a contract written in the asks, but
must land in order (Merge stays off until they have). When the watch prints "#14 unblocked: title (#12 merged)",
start it with task_start. "#14 blocked: ..." means a dependency was discarded or failed: tell the user, and change
the dependency with task_deps if they agree. Never plan a task that builds against a throwaway stub of another
task's work, to be followed by a "connect it to the real thing" task: make it wait (after) instead.

Live mode is the other way to work, when the user asks for it ("live mode", "let's work on X live"): you and the user
work on one task together, in this session, in a tight loop, usually on the UI. Don't use task_create for it (that
starts a worker). Instead, with Bash: \`development/task-queue/tq add --live "title" "ask"\`, then \`tq live <id> [/path]\`,
which marks it live and working, runs the dev server from its worktree on its port with live reload, and opens a Chrome
window of its own (its own profile and DevTools port, recorded on the task; never the user's browser) on the page.
Before acting on anything the user says, run \`tq look <id>\` (the tab in front: URL, title, selected text, console
errors; --shot saves a screenshot to read, --console all messages), so "this" means what they're looking at. Edit in
the worktree yourself (absolute paths, no worker); open pages reload by themselves. Commit as you go, test before
finishing, and finish with \`tq done <id> "summary" <url>\` (the summary in ASD-STE100, as AGENTS.md
("Task summaries") shows) when the user says it's done: they merge from the board,
which stops the dev server and closes the window. Meanwhile keep the queue watch armed and relay what it says, and
send any unrelated change the user asks for through task_create as usual. AGENTS.md ("Live mode") has the details.

Questions, explanations and anything that changes nothing in the repo are answered directly, without a task.`

const WORKER_PROMPT = `You are a task worker: you do one task from the repo's task queue, start to finish, in the task's own git
worktree, and report on the board as you go. Your first message names the task, its worktree, branch and port.

- Work only in that worktree (your working directory): absolute paths under it, never the main checkout or another
  worktree. Read its AGENTS.md and README.md first.
- Report with the task-queue tools: mcp__task-queue__task_log at milestones, so the board shows where you are.
- Commit as you go. Test thoroughly: the tests covering what you changed (./test.sh is the whole suite), and new
  tests where they belong. Verify in a browser with headless Chrome only (tests/cdp.ts drives it); never open or drive
  the user's own browser.
- Make the result visible at one URL: mcp__task-queue__task_preview runs the app from the worktree on the task's port
  and keeps it running after you finish. Choose the page (path) that shows the change best, with any state it needs
  already set up, so the user only has to open it.
- Attach screenshots where the change has a visible side: mcp__task-queue__task_screenshot with a URL (headless
  Chrome takes it) or a PNG you took yourself (e.g. after interacting, with tests/cdp.ts). When you revise a task,
  remove the screenshots that no longer match (mcp__task-queue__task_unscreenshot), or start a fresh set with
  replace: true on the first task_screenshot, so the card shows only current screenshots.
- Commit everything (uncommitted work can't be merged), then mcp__task-queue__task_done with a summary. If you can't
  finish, mcp__task-queue__task_fail with why.
- Write every summary (task_done, task_fail and your final reply) in ASD-STE100, Simplified Technical English; AGENTS.md
  ("Task summaries") has the rules and an example. In short: at most 20 words in an instruction and 25 in a
  description; one idea in each sentence; active voice; simple tenses (present, past, future); no -ing forms as nouns
  or adjectives; keep "the" and "a"; common words, one word for one meaning; technical names (files, commands,
  settings) as they are; numbered steps for procedures, lists for results; no implementation trivia, strings of
  internal names or arrow chains. Shape: one sentence on what the task changes for the user, then results (with
  numbers), changes, limits, tests, and what the user must do.
- Never merge or push: the user merges from the board.
- Run every build and test under a time limit (e.g. \`timeout 600 ./test.sh\`), and never leave processes behind
  (dev servers, watchers, browsers): stop what you start. If your own preview gets in the way of a build in the
  worktree (a dev server that the build waits on), stop it first (\`development/task-queue/tq preview <id> --stop\`),
  and start it again after.
- You are the task's agent until it merges: after task_done, stay available. If the merge needs work, the main agent
  wakes you with what stopped it (a conflict, uncommitted changes, a failed check, a step that timed out). Then, in
  the worktree: \`git fetch origin\`, merge origin's branch (origin/staging for Erga) and main into the branch, resolve
  any conflicts keeping both sides' intent, test under a time limit, commit everything, and call task_continue. The
  merge then runs again by itself. Before task_done, do the same merge yourself, so the queue finds nothing to
  conflict.
- Dependencies: if your task needs another task's work that isn't merged yet, don't build against a stand-in, stub
  or mock of it that someone must later replace. If your task merges after another (mergeAfter), build against the
  contract the ask describes, as the real thing. If you find a dependency the ask doesn't name, say so with
  task_log and task_fail rather than stubbing it out.

If the task-queue tools are missing, development/task-queue/tq in the worktree does the same from Bash (tq help).
Finish by replying with the task's URL and a two-line summary.`

const workerTask = (t: { id: number; title: string; description: string; worktree: string; branch: string; port: number; startAfter?: number[]; mergeAfter?: number[] }) =>
  `You are doing task #${t.id} from the task queue: ${t.title}

The ask:
${t.description}

Worktree: ${t.worktree}
Branch: ${t.branch}
Preview port: ${t.port}
${t.startAfter?.length ? `Started after: ${t.startAfter.map(id => `#${id}`).join(', ')} (merged into main; git merge main in the worktree if your branch predates it)\n` : ''}${t.mergeAfter?.length ? `Merges after: ${t.mergeAfter.map(id => `#${id}`).join(', ')} (not merged yet: build against the contract the ask gives, not a stub)\n` : ''}
Start now: it's already marked working.`

const TOOLS = [
  {
    name: 'task_create',
    description: 'Register a change the user asked for in the task queue and start a background worker on it in its own worktree. The main agent calls this first for every ask that changes the repo, then stays free. Returns the task number.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Add a dark mode toggle"' },
        ask: { type: 'string', description: "A short, clear description of the ask: a few plain sentences on what the user wants, plus only the context the worker can't find itself" },
        after: { type: 'array', items: { type: 'number' }, description: "Task ids this one needs merged before it starts: it stays queued, with no worker, until they merge; then start it with task_start" },
        mergeAfter: { type: 'array', items: { type: 'number' }, description: 'Task ids that must merge before this one does: built in parallel against a contract in the asks, landed in order' },
      },
      required: ['title', 'ask'],
    },
  },
  {
    name: 'task_start',
    description: "Start a worker on a queued task, e.g. one created with after: once tq watch says it's unblocked (its dependencies merged). Refused, with the reason, while it still waits.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'task_deps',
    description: "Change a task's dependencies: after (don't start until these merge) and mergeAfter (don't merge until these merge). Each list replaces the old one; [] clears it. Refused for an unknown or discarded task, or a cycle.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, after: { type: 'array', items: { type: 'number' } }, mergeAfter: { type: 'array', items: { type: 'number' } } }, required: ['id'] },
  },
  { name: 'task_log', description: "Add a progress line to a task's card on the board.", inputSchema: { type: 'object', properties: { id: { type: 'number' }, message: { type: 'string' } }, required: ['id', 'message'] } },
  {
    name: 'task_preview',
    description: "Run the task's app from its worktree on its port (bun start by default), kept running after you finish and stopped on merge; sets the task's URL to that port plus path.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, path: { type: 'string', description: 'The page that shows the change, e.g. /docs' }, command: { type: 'string', description: 'Another command, with $PORT for the port' } }, required: ['id'] },
  },
  {
    name: 'task_screenshot',
    description: 'Attach a screenshot to a task: a URL (taken with headless Chrome after it loads) or the path of an image file you took.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, target: { type: 'string', description: 'http(s) URL or absolute file path' }, caption: { type: 'string' }, fullPage: { type: 'boolean' }, wait: { type: 'number', description: 'ms to wait after load (default 1500)' }, replace: { type: 'boolean', description: "Remove the task's screenshots first: a fresh set, e.g. when you revise the task" } }, required: ['id', 'target'] },
  },
  {
    name: 'task_unscreenshot',
    description: "Remove screenshots from a task that no longer match it (e.g. after a revision): one by file name or 1-based index, or all. Not while it merges.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, file: { type: 'string', description: "The screenshot's file name (as in the task's screenshots)" }, index: { type: 'number', description: '1-based position in the task\'s screenshots' }, all: { type: 'boolean', description: 'Remove every screenshot' } }, required: ['id'] },
  },
  {
    name: 'task_done',
    description: 'Mark a task complete (ready for the user to merge): everything committed, tested, previewed.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, summary: { type: 'string', description: 'For the user, in ASD-STE100 (Simplified Technical English, see AGENTS.md "Task summaries"): what changed for the user, results, changes, limits, tests, what the user must do' }, url: { type: 'string', description: 'Where to look, if not the preview URL already set' } }, required: ['id', 'summary'] },
  },
  { name: 'task_fail', description: "Mark a task failed, with why.", inputSchema: { type: 'object', properties: { id: { type: 'number' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
  {
    name: 'task_continue',
    description: "After fixing what stopped the task's merge (status needs-agent: a conflict, uncommitted changes, a failed check, a step that timed out) and committing everything in the worktree: merge it again. Refused while the worktree has uncommitted changes or an unfinished merge.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  { name: 'task_list', description: 'List the tasks in the queue that are not done.', inputSchema: { type: 'object', properties: {} } },
]

type Api = { ok: boolean; data: any; error?: string }

async function api($: EngineInterface, method: string, path: string, body?: unknown): Promise<Api> {
  try {
    const res = await $.http.fetch(QUEUE + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = res.text ? JSON.parse(res.text) : {}
    return { ok: res.ok, data, error: res.ok ? undefined : data.error ?? `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, data: null, error: `the task queue isn't answering at ${QUEUE} (${(err as Error).message})` }
  }
}

const brief = (t: any): Task => ({
  id: t.id, title: t.title, status: t.status, branch: t.branch, url: t.url, previewUp: t.previewUp, live: t.live,
  error: t.error, commit: t.commit, updatedAt: t.updatedAt, last: t.log?.[t.log.length - 1]?.message, agent: t.agent,
  startAfter: t.startAfter, mergeAfter: t.mergeAfter, blockedBy: t.blockedBy,
})

const ids = (list: number[]) => list.map(id => `#${id}`).join(', ')
/** What blocks a task, as a key to compare between polls: "s:12" can't start, "m:12" can't merge, "x:12" stuck. */
const blockKey = (t: Task) => { const b = t.blockedBy; return !b ? '' : b.stuck.length ? `x:${b.stuck}` : b.start.length ? `s:${b.start}` : `m:${b.merge}` }
/** Why a task can't merge now, or nothing: a dependency neither merged nor merging (ahead of it). */
const mergeBlocked = (t: Task, list: Task[]) => {
  const b = t.blockedBy
  if (!b) return undefined
  if (b.stuck.length) return b.reason
  const notYet = b.merge.filter(id => list.find(x => x.id === id)?.status !== 'merging')
  return notYet.length ? `can't merge until ${ids(notYet)} merge${notYet.length === 1 ? 's' : ''}` : undefined
}

const say = (text: string) => ({ result: text })

// Where the queue lives: the main checkout of the session's repo (from a worktree too). Null: not here.
let root: string | null = null
let lastStart = 0
const seen = new Map<number, { status: string; blocked: string }>()
let hasPolled = false

async function startServer($: EngineInterface) {
  if (!root) return
  const now = await $.clock.now()
  if (now - lastStart < 30_000) return
  lastStart = now
  await $.process.run([`${root}/development/task-queue/tq`, 'serve'], { cwd: root, timeoutMs: 20_000 }).catch(() => undefined)
}

async function poll($: EngineInterface) {
  const r = await api($, 'GET', '/api/tasks')
  if (!r.ok) {
    await update($, isOnline, () => false)
    $.ui.status('tasks: queue offline')
    await startServer($)
    return
  }
  const list: Task[] = r.data.map(brief)
  await update($, isOnline, () => true)
  await update($, tasks, () => list)
  // Toasts for what changed since the last poll (none for what was already there).
  const isFirst = !hasPolled
  hasPolled = true
  for (const t of list) {
    const was = seen.get(t.id)
    const key = blockKey(t)
    seen.set(t.id, { status: t.status, blocked: key })
    if (isFirst) continue
    // Dependencies: unblocked (it can start, or merge), or blocked for good (one discarded or failed).
    if (was && was.blocked !== key && !['merged', 'discarded'].includes(t.status)) {
      const freed = (was.blocked.slice(2).split(',').filter(Boolean).map(Number)).filter(id => !key.slice(2).split(',').map(Number).includes(id))
      const why = freed.map(id => `#${id} ${list.find(x => x.id === id)?.status === 'merged' ? 'merged' : 'removed'}`).join(', ')
      if (t.status === 'queued' && was.blocked.startsWith('s:') && !key.startsWith('s:') && !key.startsWith('x:')) $.ui.toast(`Task #${t.id} unblocked: ${t.title} (${why})`)
      else if (t.status === 'complete' && was.blocked && !key) $.ui.toast(`Task #${t.id} can merge now: ${t.title} (${why})`)
      else if (key.startsWith('x:') && !was.blocked.startsWith('x:')) $.ui.toast(`Task #${t.id} blocked: ${t.blockedBy?.reason ?? ''}`.slice(0, 200))
    }
    const before = was?.status
    if (before === t.status) continue
    if (t.status === 'merging') $.ui.toast(`Task #${t.id} merging: ${t.title}`)
    if (t.status === 'complete' && before !== 'merging') $.ui.toast(`Task #${t.id} ready to merge: ${t.title}`)
    if (t.status === 'complete' && before === 'merging') $.ui.toast(`Task #${t.id} merge failed: ${t.error ?? ''}`.slice(0, 200))
    if (t.status === 'needs-agent') $.ui.toast(`Task #${t.id} needs its agent${t.agent ? ` (${t.agent})` : ''}: ${t.error ?? ''}`.slice(0, 200))
    if (t.status === 'merged') $.ui.toast(`Task #${t.id} merged and pushed (${t.commit})`)
    if (t.status === 'failed') $.ui.toast(`Task #${t.id} failed: ${t.error ?? ''}`.slice(0, 200))
  }
  const count = (s: Task['status'][]) => list.filter(t => s.includes(t.status)).length
  const waiting = list.filter(t => t.status === 'queued' && t.blockedBy?.start.length).length
  const parts = [
    [count(['queued', 'working']) - waiting, 'working'],
    [waiting, 'waiting'],
    [count(['complete']), 'ready'],
    [count(['merging']), 'merging'],
    [count(['needs-agent']), 'need agent'],
    [count(['failed']), 'failed'],
  ].filter(([n]) => n).map(([n, label]) => `${n} ${label}`)
  $.ui.status(parts.length ? `tasks: ${parts.join(' · ')}` : undefined)
}

/** The pane's Merge: the task is merging at once (its Merge gone), then the poll follows it to merged or back. */
async function merge($: EngineInterface, id: number) {
  const r = await api($, 'POST', `/api/tasks/${id}/merge`)
  if (r.ok) await update($, tasks, list => list.map(t => (t.id === id ? brief(r.data) : t)))
  else $.ui.toast(`Task #${id} didn't start merging: ${r.error}`.slice(0, 200))
  await poll($)
}

/** Marks a registered task working and spawns its worker in its worktree. */
async function startWorker($: EngineInterface, t: any) {
  const started = await api($, 'PATCH', `/api/tasks/${t.id}`, { status: 'working', message: 'Worker starting' })
  if (!started.ok) return say(`Task #${t.id} didn't start: ${started.error}`)
  const spawned = await $.agent.spawn({
    subagentType: WORKER,
    description: `Task #${t.id}: ${t.title}`.slice(0, 60),
    prompt: workerTask(t),
    cwd: t.worktree,
  })
  if ('deny' in spawned && spawned.deny) {
    await api($, 'PATCH', `/api/tasks/${t.id}`, { status: 'queued', message: `Worker didn't start: ${spawned.deny}` })
    return say(`Task #${t.id} is on the board, but its worker didn't start (${spawned.deny}). Start one yourself: Agent tool, subagent_type "${WORKER}", run_in_background, prompt:\n\n${workerTask(t)}`)
  }
  // One agent per task until it merges: the one to wake if its merge needs work.
  const agentId = (spawned as { agentId?: string }).agentId
  if (agentId) await api($, 'PATCH', `/api/tasks/${t.id}`, { agent: agentId })
  await api($, 'POST', `/api/tasks/${t.id}/log`, { message: 'Worker started' })
  return say(`Task #${t.id} is on the board (http://localhost:4700) and its worker has started in ${t.worktree}. Tell the user in one line and stay free; the worker reports back when it's done.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const git = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: e.cwd }).catch(() => null)
    const common = git?.exitCode === 0 ? git.stdout.trim() : ''
    const candidate = common.replace(/\/\.git\/?$/, '')
    const isHere = !!common && (await $.fs.stat(`${candidate}/development/task-queue/server.ts`).then(() => true, () => false))
    if (!isHere) return started
    root = candidate

    for (const tool of TOOLS) await $.tool.register(tool)
    await $.agent.register({
      name: 'worker',
      description: 'Does one task from the task queue in its worktree: implements, tests, previews, screenshots, reports. Started by task_create.',
      prompt: WORKER_PROMPT,
    })
    await $.command.register({ name: 'tasks', description: 'Show the task queue in a pane (/tasks board opens it in the browser)' })
    await startServer($)
    await poll($)
    $.clock.every(2000, () => poll($))
    return started
  })

  // The workflow, for the main agent only (a worker's own prompt is WORKER_PROMPT).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!root || e.traits.includes('teammate')) return composed
    return { sections: [...composed.sections, { id: 'task-queue:workflow', text: WORKFLOW, scope: 'session' as const }] }
  })

  on('command.run', { command: 'tasks' }, async ($, e) => {
    if (!root) return { text: 'No task queue in this repo (development/task-queue).' }
    if (String((e as { args?: string }).args ?? '').trim() === 'board') {
      await $.process.run(['open', 'http://localhost:4700/'])
      return { text: 'Opened the board: http://localhost:4700/' }
    }
    await $.ui.open({ id: PANE, title: 'Tasks' })
    return { text: 'Tasks pane opened (/tasks board for the browser board).' }
  })

  // ---- the tools ----------------------------------------------------------

  on('tool.call', { tool: 'mcp__task-queue__task_create' }, async ($, e) => {
    if (e.agentId) return { deny: 'Task workers do their own task; only the main agent creates tasks.' }
    const input = e as unknown as { title: string; ask: string; after?: number[]; mergeAfter?: number[] }
    const made = await api($, 'POST', '/api/tasks', {
      title: input.title, description: input.ask,
      ...(input.after?.length ? { startAfter: input.after } : {}), ...(input.mergeAfter?.length ? { mergeAfter: input.mergeAfter } : {}),
    })
    if (!made.ok) return say(`Couldn't register the task: ${made.error}`)
    const t = made.data
    if (!t.worktree) return say(`Task #${t.id} was registered but has no worktree: ${t.error ?? 'unknown error'}`)
    if (t.blockedBy?.start?.length) {
      return say(`Task #${t.id} is on the board, queued: ${t.blockedBy.reason}. No worker yet. When the queue watch prints "#${t.id} unblocked", start it with task_start. Tell the user in one line and stay free.`)
    }
    return startWorker($, t)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_start' }, async ($, e) => {
    if (e.agentId) return { deny: 'Only the main agent starts tasks.' }
    const { id } = e as unknown as { id: number }
    const r = await api($, 'GET', `/api/tasks/${id}`)
    if (!r.ok) return say(`Failed: ${r.error}`)
    if (r.data.status !== 'queued') return say(`Task #${id} is ${r.data.status}, not queued: nothing to start.`)
    if (r.data.blockedBy?.start?.length || r.data.blockedBy?.stuck?.length) return say(`Task #${id} can't start yet: ${r.data.blockedBy.reason}.`)
    return startWorker($, r.data)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_deps' }, async ($, e) => {
    const { id, after, mergeAfter } = e as unknown as { id: number; after?: number[]; mergeAfter?: number[] }
    const r = await api($, 'PATCH', `/api/tasks/${id}`, { ...(after ? { startAfter: after } : {}), ...(mergeAfter ? { mergeAfter } : {}) })
    if (!r.ok) return say(`Failed: ${r.error}`)
    const t = r.data
    return say(`Task #${id}: starts after ${t.startAfter?.length ? ids(t.startAfter) : 'nothing'}; merges after ${t.mergeAfter?.length ? ids(t.mergeAfter) : 'nothing'}. ${t.blockedBy ? `Now ${t.blockedBy.reason}.` : 'Nothing blocks it.'}${t.status === 'queued' && !t.blockedBy?.start?.length ? ' It can start: task_start.' : ''}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_log' }, async ($, e) => {
    const { id, message } = e as unknown as { id: number; message: string }
    const r = await api($, 'POST', `/api/tasks/${id}/log`, { message })
    return say(r.ok ? 'Logged.' : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_preview' }, async ($, e) => {
    const { id, path, command } = e as unknown as { id: number; path?: string; command?: string }
    const r = await api($, 'POST', `/api/tasks/${id}/preview`, { path, command })
    return say(r.ok ? `Preview starting at ${r.data.url} (log: development/task-queue/data/logs/task-${id}-preview.log). Give it a few seconds before loading it.` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_screenshot' }, async ($, e) => {
    const { id, target, caption, fullPage, wait, replace } = e as unknown as { id: number; target: string; caption?: string; fullPage?: boolean; wait?: number; replace?: boolean }
    if (replace) {
      const cleared = await api($, 'DELETE', `/api/tasks/${id}/screenshots`)
      if (!cleared.ok) return say(`Failed: ${cleared.error}`)
    }
    const body = /^https?:/.test(target) ? { url: target, caption, fullPage, wait } : { path: target, caption }
    const r = await api($, 'POST', `/api/tasks/${id}/screenshots`, body)
    return say(r.ok ? `Attached (${r.data.screenshots.length} on the task).` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_unscreenshot' }, async ($, e) => {
    const { id, file, index, all } = e as unknown as { id: number; file?: string; index?: number; all?: boolean }
    if (!all && !file && !index) return say('Say which: file, index, or all: true.')
    const r = await api($, 'DELETE', `/api/tasks/${id}/screenshots${all ? '' : `/${encodeURIComponent(String(file ?? index))}`}`)
    return say(r.ok ? `Removed (${r.data.screenshots.length} left on the task).` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_done' }, async ($, e) => {
    const { id, summary, url } = e as unknown as { id: number; summary: string; url?: string }
    const r = await api($, 'PATCH', `/api/tasks/${id}`, { status: 'complete', summary, ...(url ? { url } : {}), message: 'Complete: ready to merge' })
    return say(r.ok ? `Task #${id} is ready to merge; the user sees it at ${r.data.url ?? 'the board'}.` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_fail' }, async ($, e) => {
    const { id, reason } = e as unknown as { id: number; reason: string }
    const r = await api($, 'PATCH', `/api/tasks/${id}`, { status: 'failed', error: reason, message: `Failed: ${reason}` })
    return say(r.ok ? `Task #${id} marked failed.` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_continue' }, async ($, e) => {
    const { id } = e as unknown as { id: number }
    const r = await api($, 'POST', `/api/tasks/${id}/continue`)
    return say(r.ok ? `Task #${id} is merging again. If it stops again, the main agent tells you why.` : `Failed: ${r.error}`)
  })

  on('tool.call', { tool: 'mcp__task-queue__task_list' }, async $ => {
    const r = await api($, 'GET', '/api/tasks')
    if (!r.ok) return say(`Failed: ${r.error}`)
    const open = (r.data as any[]).filter(t => !['merged', 'discarded'].includes(t.status))
    return say(open.length ? open.map(t => `#${t.id} [${t.status}] ${t.title}${t.url ? ` ${t.url}` : ''}${t.blockedBy ? ` (${t.blockedBy.reason})` : ''}`).join('\n') : 'No open tasks.')
  })

  // ---- the pane -----------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tasks)
    const online = await read($, isOnline)
    const armedId = await read($, armed)
    const open = (url: string) => () => { void $.process.run(['open', url]) }
    const groups: [string, Task['status'][]][] = [
      ['Working', ['queued', 'working', 'failed']],
      ['Needs agent', ['needs-agent']],
      ['Ready to merge', ['complete']],
      ['Merging', ['merging']],
      ['Done', ['merged']],
    ]

    return (
      <Box flexDirection="column">
        <Box key="head">
          <Text dimColor>{online ? 'live · ' : 'queue offline · '}</Text>
          <Button key="board" label="Board" onPress={open('http://localhost:4700/')} />
        </Box>
        {groups.map(([title, statuses]) => {
          const rows = list.filter(t => statuses.includes(t.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, title === 'Done' ? 5 : 50)
          return (
            <Box key={title} flexDirection="column" marginTop={1}>
              <Text bold>{title} ({rows.length})</Text>
              {rows.length === 0 && <Text dimColor>  nothing</Text>}
              {rows.map(t => (
                <Box key={`t${t.id}`} flexDirection="column">
                  <Text color={t.status === 'failed' ? 'red' : t.status === 'needs-agent' ? 'magenta' : undefined}>
                    #{t.id} {t.title}{t.live ? ' · live' : ''}{t.status === 'failed' ? ' (failed)' : ''}{t.status === 'needs-agent' ? ` · agent ${t.agent ?? 'none recorded'}` : ''}{t.status === 'merged' ? ` · ${t.commit ?? ''}` : ''}
                  </Text>
                  {t.blockedBy && <Text color={t.blockedBy.stuck.length ? 'red' : 'yellow'}>  {t.blockedBy.reason}</Text>}
                  {t.status !== 'merged' && (t.error || t.last) && <Text dimColor>  {(t.error ?? t.last ?? '').split('\n')[0]?.slice(0, 100)}</Text>}
                  {t.status !== 'merged' && (
                    <Box key={`a${t.id}`}>
                      <Text>  </Text>
                      {t.url && <Button key={`open${t.id}`} label={t.previewUp ? 'Open ●' : 'Open ○'} onPress={open(t.url)} />}
                      {t.status === 'complete' && !mergeBlocked(t, list) && <Button key={`merge${t.id}`} label="Merge" onPress={() => merge($, t.id)} />}
                      {t.status !== 'merging' && (armedId === t.id
                        ? <Button key={`discard${t.id}`} label="Discard branch?" onPress={() => { void update($, armed, () => null); void api($, 'POST', `/api/tasks/${t.id}/discard`).then(() => poll($)) }} />
                        : <Button key={`arm${t.id}`} label="Discard" onPress={() => { void update($, armed, () => t.id) }} />)}
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
