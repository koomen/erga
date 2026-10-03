import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'

// The task queue (development/task-queue in the repo) stays the source of
// truth and the browser board; this mod is its front end in Claude Code:
//   - task_create: registers a task and starts a worker in its worktree, in one call
//   - task_log / task_preview / task_screenshot / task_done / task_fail: the worker's reports
//   - the worker agent type, its instructions built in
//   - the workflow rule in the main agent's system prompt
//   - a Tasks pane (/tasks) with Open / Merge / Discard, a status entry, toasts
//     (ready to merge, merging, merged, merge failed, failed)
// It does nothing in a repo without development/task-queue/server.ts.

const QUEUE = 'http://127.0.0.1:4700'
const PANE = 'task-queue'
const WORKER = 'task-queue:worker'

const tasks = atom({ plugin: 'task-queue', key: 'tasks' } as const, [])
const isOnline = atom({ plugin: 'task-queue', key: 'isOnline' } as const, false)
const armed = atom({ plugin: 'task-queue', key: 'armed' } as const, null)

const WORKFLOW = `# The task queue

This repo tracks work in a task queue (board: http://localhost:4700). When the user asks for a change to the repo,
your first and only step is to call mcp__task-queue__task_create with a short imperative title and the user's ask in
full (with any context from the conversation the worker will need). That registers the task, makes its branch and
worktree, and starts a background worker that does, tests and reports the work. Then tell the user in one line that
it's task #<id> on the board, and stay free for their next instruction: don't implement, test or merge it yourself,
and don't wait on the worker. Several tasks may run at once. When a worker reports back, relay its URL and summary in
a sentence or two. The user merges from the board or the Tasks pane (/tasks).

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
  Chrome takes it) or a PNG you took yourself (e.g. after interacting, with tests/cdp.ts).
- Commit everything (uncommitted work can't be merged), then mcp__task-queue__task_done with a summary: what changed,
  how you tested it, what to look at. If you can't finish, mcp__task-queue__task_fail with why.
- Never merge or push: the user merges from the board.

If the task-queue tools are missing, development/task-queue/tq in the worktree does the same from Bash (tq help).
Finish by replying with the task's URL and a two-line summary.`

const workerTask = (t: { id: number; title: string; description: string; worktree: string; branch: string; port: number }) =>
  `You are doing task #${t.id} from the task queue: ${t.title}

The ask:
${t.description}

Worktree: ${t.worktree}
Branch: ${t.branch}
Preview port: ${t.port}

Start now: it's already marked working.`

const TOOLS = [
  {
    name: 'task_create',
    description: 'Register a change the user asked for in the task queue and start a background worker on it in its own worktree. The main agent calls this first for every ask that changes the repo, then stays free. Returns the task number.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Add a dark mode toggle"' },
        ask: { type: 'string', description: "The user's ask in full, with any context from the conversation the worker needs" },
      },
      required: ['title', 'ask'],
    },
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
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, target: { type: 'string', description: 'http(s) URL or absolute file path' }, caption: { type: 'string' }, fullPage: { type: 'boolean' }, wait: { type: 'number', description: 'ms to wait after load (default 1500)' } }, required: ['id', 'target'] },
  },
  {
    name: 'task_done',
    description: 'Mark a task complete (ready for the user to merge): everything committed, tested, previewed.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, summary: { type: 'string', description: 'What changed, how it was tested, what to look at' }, url: { type: 'string', description: 'Where to look, if not the preview URL already set' } }, required: ['id', 'summary'] },
  },
  { name: 'task_fail', description: "Mark a task failed, with why.", inputSchema: { type: 'object', properties: { id: { type: 'number' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
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
  id: t.id, title: t.title, status: t.status, branch: t.branch, url: t.url, previewUp: t.previewUp,
  error: t.error, commit: t.commit, updatedAt: t.updatedAt, last: t.log?.[t.log.length - 1]?.message,
})

const say = (text: string) => ({ result: text })

// Where the queue lives: the main checkout of the session's repo (from a worktree too). Null: not here.
let root: string | null = null
let lastStart = 0
const seen = new Map<number, string>()
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
    const before = seen.get(t.id)
    seen.set(t.id, t.status)
    if (isFirst || before === t.status) continue
    if (t.status === 'merging') $.ui.toast(`Task #${t.id} merging: ${t.title}`)
    if (t.status === 'complete' && before !== 'merging') $.ui.toast(`Task #${t.id} ready to merge: ${t.title}`)
    if (t.status === 'complete' && before === 'merging') $.ui.toast(`Task #${t.id} merge failed: ${t.error ?? ''}`.slice(0, 200))
    if (t.status === 'merged') $.ui.toast(`Task #${t.id} merged and pushed (${t.commit})`)
    if (t.status === 'failed') $.ui.toast(`Task #${t.id} failed: ${t.error ?? ''}`.slice(0, 200))
  }
  const count = (s: Task['status'][]) => list.filter(t => s.includes(t.status)).length
  const parts = [
    [count(['queued', 'working']), 'working'],
    [count(['complete']), 'ready'],
    [count(['merging']), 'merging'],
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
    const input = e as unknown as { title: string; ask: string }
    const made = await api($, 'POST', '/api/tasks', { title: input.title, description: input.ask })
    if (!made.ok) return say(`Couldn't register the task: ${made.error}`)
    const t = made.data
    if (!t.worktree) return say(`Task #${t.id} was registered but has no worktree: ${t.error ?? 'unknown error'}`)
    await api($, 'PATCH', `/api/tasks/${t.id}`, { status: 'working', message: 'Worker starting' })
    const spawned = await $.agent.spawn({
      subagentType: WORKER,
      description: `Task #${t.id}: ${input.title}`.slice(0, 60),
      prompt: workerTask(t),
      cwd: t.worktree,
    })
    if ('deny' in spawned && spawned.deny) {
      await api($, 'PATCH', `/api/tasks/${t.id}`, { status: 'queued', message: `Worker didn't start: ${spawned.deny}` })
      return say(`Task #${t.id} is on the board, but its worker didn't start (${spawned.deny}). Start one yourself: Agent tool, subagent_type "${WORKER}", run_in_background, prompt:\n\n${workerTask(t)}`)
    }
    await api($, 'POST', `/api/tasks/${t.id}/log`, { message: 'Worker started' })
    return say(`Task #${t.id} is on the board (http://localhost:4700) and its worker has started in ${t.worktree}. Tell the user in one line and stay free; the worker reports back when it's done.`)
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
    const { id, target, caption, fullPage, wait } = e as unknown as { id: number; target: string; caption?: string; fullPage?: boolean; wait?: number }
    const body = /^https?:/.test(target) ? { url: target, caption, fullPage, wait } : { path: target, caption }
    const r = await api($, 'POST', `/api/tasks/${id}/screenshots`, body)
    return say(r.ok ? `Attached (${r.data.screenshots.length} on the task).` : `Failed: ${r.error}`)
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

  on('tool.call', { tool: 'mcp__task-queue__task_list' }, async $ => {
    const r = await api($, 'GET', '/api/tasks')
    if (!r.ok) return say(`Failed: ${r.error}`)
    const open = (r.data as any[]).filter(t => !['merged', 'discarded'].includes(t.status))
    return say(open.length ? open.map(t => `#${t.id} [${t.status}] ${t.title}${t.url ? ` ${t.url}` : ''}`).join('\n') : 'No open tasks.')
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
                  <Text color={t.status === 'failed' ? 'red' : undefined}>
                    #{t.id} {t.title}{t.status === 'failed' ? ' (failed)' : ''}{t.status === 'merged' ? ` · ${t.commit ?? ''}` : ''}
                  </Text>
                  {t.status !== 'merged' && (t.error || t.last) && <Text dimColor>  {(t.error ?? t.last ?? '').split('\n')[0]?.slice(0, 100)}</Text>}
                  {t.status !== 'merged' && (
                    <Box key={`a${t.id}`}>
                      <Text>  </Text>
                      {t.url && <Button key={`open${t.id}`} label={t.previewUp ? 'Open ●' : 'Open ○'} onPress={open(t.url)} />}
                      {t.status === 'complete' && <Button key={`merge${t.id}`} label="Merge" onPress={() => merge($, t.id)} />}
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
