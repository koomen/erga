import { expect, mock, test } from 'claude-code/testing'

// The engine beneath the mod, faked: a repo with a task queue at /repo, a queue
// that answers from memory, a spawn that always starts, and toasts and the
// status line kept for the test to read.
function fakeQueue(on: any) {
  const tasks: any[] = []
  const spawned: any[] = []
  const agents: any[] = []
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // Calls on $ answer { value }.
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', (_$: any, e: any) => { status.push(e.text); return { value: undefined } })
  on('process.run', (_$: any, e: any) =>
    ({ value: e.argv[0] === 'git' ? { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } }))
  on('fs.stat', () => ({ value: { type: 'file', size: 1, mtimeMs: 0 } }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__task-queue__${e.name}` } }))
  on('agent.register', (_$: any, e: any) => { agents.push(e); return { value: { agent: `task-queue:${e.name}` } } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { shown: true } }))
  on('agent.spawn', (_$: any, e: any) => { spawned.push(e); return { model: 'm', agentId: 'a1' } })
  on('http.fetch', (_$: any, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('http://127.0.0.1:4700', '')
    const body = e.init?.body ? JSON.parse(e.init.body) : {}
    // Like the queue, a task's blockedBy is computed on every answer: startAfter / mergeAfter tasks not merged yet.
    const blocked = () => { for (const x of tasks) {
      const unmet = (l?: number[]) => (l ?? []).filter(id => tasks[id - 1]?.status !== 'merged')
      const merge = [...new Set([...unmet(x.startAfter), ...unmet(x.mergeAfter)])]
      const start = x.status === 'queued' ? unmet(x.startAfter) : []
      const stuck = merge.filter(id => ['discarded', 'failed'].includes(tasks[id - 1]?.status))
      x.blockedBy = merge.length && !['merged', 'discarded'].includes(x.status)
        ? { start, merge, stuck, reason: stuck.length ? `blocked: #${stuck[0]} was discarded; remove or change the dependency` : start.length ? `waiting for #${start.join(', #')} to merge` : `can't merge until #${merge.join(', #')} merges` }
        : undefined
    } }
    const ok = (data: unknown, status = 200) => { blocked(); return { value: { status, ok: true, headers: {}, text: JSON.stringify(data) } } }
    const no = (status: number, error: string) => ({ value: { status, ok: false, headers: {}, text: JSON.stringify({ error }) } })
    if (method === 'POST' && path === '/api/tasks') {
      const t: any = { id: tasks.length + 1, title: body.title, description: body.description, status: 'queued', screenshots: [] as any[], worktree: `/repo/.claude/worktrees/task-${tasks.length + 1}`, branch: 'task/1-x', port: 4501, log: [], updatedAt: new Date().toISOString(), startAfter: body.startAfter, mergeAfter: body.mergeAfter }
      tasks.push(t)
      return ok(t, 201)
    }
    const m = path.match(/^\/api\/tasks\/(\d+)/)
    const t = m ? tasks[Number(m[1]) - 1] : undefined
    if (method === 'GET' && t) return ok(t)
    if (method === 'PATCH' && t) {
      blocked()
      if (body.status === 'working' && t.status !== 'working' && t.blockedBy?.start.length) return no(409, `task ${t.id} can't start: ${t.blockedBy.reason}`)
      Object.assign(t, body)
      return ok(t)
    }
    if (method === 'POST' && t && path.endsWith('/merge')) {
      if (t.status !== 'complete') return { value: { status: 409, ok: false, headers: {}, text: JSON.stringify({ error: `task ${t.id} is ${t.status}, not complete` }) } }
      t.status = 'merging'
      return ok(t, 202)
    }
    if (method === 'POST' && t && path.endsWith('/continue')) {
      if (t.status !== 'needs-agent') return no(409, `task ${t.id} is ${t.status}: tq continue is for a task whose merge waits for its agent (needs-agent)`)
      t.status = 'merging'
      return ok(t, 202)
    }
    if (method === 'POST' && t && path.endsWith('/screenshots')) { t.screenshots.push({ file: `f${t.screenshots.length + 1}.png`, caption: body.caption }); return ok(t) }
    if (method === 'DELETE' && t) {
      const which = path.match(/\/screenshots\/(.+)$/)?.[1]
      t.screenshots = which ? t.screenshots.filter((s: any, i: number) => s.file !== which && String(i + 1) !== which) : []
      return ok(t)
    }
    if (method === 'POST' && t) { if (body.message) t.log.push({ message: body.message }); return ok(t) }
    return ok(tasks)
  })
  return { tasks, spawned, toasts, status, clock, agents }
}

test('task_create registers the task and starts a worker in its worktree', async ($, on) => {
  const { tasks, spawned } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'Add a thing', ask: 'Please add a thing' } as any)
  expect(tasks).toHaveLength(1)
  expect(tasks[0].status).toBe('working')
  expect(spawned[0].subagent_type).toBe('task-queue:worker') // the Agent tool's input, as the engine raises it
  expect(spawned[0].cwd).toBe('/repo/.claude/worktrees/task-1')
  expect(spawned[0].prompt).toContain('Please add a thing')
  expect(JSON.stringify(r)).toContain('Task #1')
  // (The worker's agent id is recorded on the task from $.agent.spawn's agentId, which only core sets: a fake can't.)
})

test('task_done marks the task complete', async ($, on) => {
  const { tasks } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'X', ask: 'Y' } as any)
  await $.tool.call({ tool: 'mcp__task-queue__task_done', id: 1, summary: 'Did it' } as any)
  expect(tasks[0].status).toBe('complete')
  expect(tasks[0].summary).toBe('Did it')
})

test('task_unscreenshot removes one screenshot or all, and task_screenshot replace starts a fresh set', async ($, on) => {
  const { tasks } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'X', ask: 'Y' } as any)
  for (const caption of ['a', 'b', 'c']) await $.tool.call({ tool: 'mcp__task-queue__task_screenshot', id: 1, target: '/tmp/x.png', caption } as any)
  await $.tool.call({ tool: 'mcp__task-queue__task_unscreenshot', id: 1, index: 2 } as any)
  expect(tasks[0].screenshots.map((s: any) => s.caption)).toEqual(['a', 'c'])
  await $.tool.call({ tool: 'mcp__task-queue__task_unscreenshot', id: 1, file: 'f1.png' } as any)
  expect(tasks[0].screenshots.map((s: any) => s.caption)).toEqual(['c'])
  await $.tool.call({ tool: 'mcp__task-queue__task_screenshot', id: 1, target: '/tmp/y.png', caption: 'new', replace: true } as any)
  expect(tasks[0].screenshots.map((s: any) => s.caption)).toEqual(['new'])
  await $.tool.call({ tool: 'mcp__task-queue__task_unscreenshot', id: 1, all: true } as any)
  expect(tasks[0].screenshots).toHaveLength(0)
})

const start = async ($: any, on: any) => {
  const queue = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'Add a thing', ask: 'Please' } as any)
  await $.tool.call({ tool: 'mcp__task-queue__task_done', id: 1, summary: 'Did it' } as any)
  await queue.clock.advance(2000)
  return queue
}

test('a merge toasts as it starts, counts as merging on the status line, and toasts when merged', async ($, on) => {
  const { clock, tasks, toasts, status } = await start($, on)
  expect(toasts.at(-1)).toBe('Task #1 ready to merge: Add a thing')
  expect(status.at(-1)).toBe('tasks: 1 ready')
  tasks[0].status = 'merging'
  await clock.advance(2000)
  expect(toasts.at(-1)).toBe('Task #1 merging: Add a thing')
  expect(status.at(-1)).toBe('tasks: 1 merging')
  Object.assign(tasks[0], { status: 'merged', commit: 'abc1234' })
  await clock.advance(2000)
  expect(toasts.at(-1)).toBe('Task #1 merged and pushed (abc1234)')
  expect(status.at(-1)).toBeUndefined()
})

test('a failed merge toasts the reason, back to ready', async ($, on) => {
  const { clock, tasks, toasts, status } = await start($, on)
  tasks[0].status = 'merging'
  await clock.advance(2000)
  Object.assign(tasks[0], { status: 'complete', error: 'has uncommitted changes' })
  await clock.advance(2000)
  expect(toasts.at(-1)).toBe('Task #1 merge failed: has uncommitted changes')
  expect(status.at(-1)).toBe('tasks: 1 ready')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane's Merge moves the task to Merging and hides its Merge and Discard (${surface})`, async ($, on) => {
    const { tasks, toasts } = await start($, on)
    const pane = await $.ui.mount({ plugin: 'task-queue', surface, component: 'Pane', requestId: 'task-queue', props: { title: 'Tasks', isFocused: true, bodyColumns: 80 } as any })
    expect(await pane.find({ text: 'Ready to merge (1)' })).toBeDefined()
    expect(await pane.find({ key: 'merge1' })).toBeDefined()
    await pane.press({ key: 'merge1' })
    expect(tasks[0].status).toBe('merging')
    expect(toasts.at(-1)).toBe('Task #1 merging: Add a thing')
    expect(await pane.find({ text: 'Merging (1)' })).toBeDefined()
    expect(await pane.find({ text: 'Ready to merge (0)' })).toBeDefined()
    expect(await pane.find({ key: 'merge1' })).toBeUndefined()
    expect(await pane.find({ key: 'arm1' })).toBeUndefined()
    expect(await pane.find({ key: 'open1' })).toBeUndefined() // no url set in this fake
  })
}

test('task_create with after leaves the task queued with no worker; task_start starts it once the dependency merges', async ($, on) => {
  const { tasks, spawned, toasts, status, clock } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'The API', ask: 'Add the API' } as any)
  const r = await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'Use the API', ask: 'Call it', after: [1] } as any)
  expect(tasks[1].startAfter).toEqual([1])
  expect(tasks[1].status).toBe('queued')
  expect(spawned).toHaveLength(1) // only #1's worker
  expect(JSON.stringify(r)).toContain('waiting for #1 to merge')
  expect(JSON.stringify(r)).toContain('task_start')
  await clock.advance(2000)
  expect(status.at(-1)).toBe('tasks: 1 working · 1 waiting')
  const early = await $.tool.call({ tool: 'mcp__task-queue__task_start', id: 2 } as any)
  expect(JSON.stringify(early)).toContain("can't start yet: waiting for #1 to merge")
  expect(spawned).toHaveLength(1)
  Object.assign(tasks[0], { status: 'merged', commit: 'abc1234' })
  await clock.advance(2000)
  expect(toasts).toContain('Task #2 unblocked: Use the API (#1 merged)')
  await $.tool.call({ tool: 'mcp__task-queue__task_start', id: 2 } as any)
  expect(spawned).toHaveLength(2)
  expect(tasks[1].status).toBe('working')
  expect(spawned[1].prompt).toContain('Started after: #1')
})

test('mergeAfter: the worker starts at once, the pane hides Merge until the dependency merges, and task_deps changes it', async ($, on) => {
  const { tasks, spawned, toasts, clock } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'First', ask: 'A' } as any)
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'Second', ask: 'B', mergeAfter: [1] } as any)
  expect(spawned).toHaveLength(2)
  expect(spawned[1].prompt).toContain('Merges after: #1')
  await $.tool.call({ tool: 'mcp__task-queue__task_done', id: 2, summary: 'Done' } as any)
  await clock.advance(2000)
  const pane = await $.ui.mount({ plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue', props: { title: 'Tasks', isFocused: true, bodyColumns: 80 } as any })
  expect(await pane.find({ text: "can't merge until #1 merges" })).toBeDefined()
  expect(await pane.find({ key: 'merge2' })).toBeUndefined()
  Object.assign(tasks[0], { status: 'merged', commit: 'abc1234' })
  await clock.advance(2000)
  expect(toasts).toContain('Task #2 can merge now: Second (#1 merged)')
  const r = await $.tool.call({ tool: 'mcp__task-queue__task_deps', id: 2, mergeAfter: [] } as any)
  expect(tasks[1].mergeAfter).toEqual([])
  expect(JSON.stringify(r)).toContain('Nothing blocks it')
})

test('the worker prompt warns against building on stand-ins for blocked dependencies', async ($, on) => {
  const { agents } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(agents[0].name).toBe('worker')
  expect(agents[0].prompt).toContain("don't build against a stand-in, stub")
})

test('a merge that needs the agent: toast with the agent, status line, the pane\'s own group, and task_continue merges again', async ($, on) => {
  const { clock, tasks, toasts, status } = await start($, on)
  tasks[0].status = 'merging'
  await clock.advance(2000)
  Object.assign(tasks[0], { status: 'needs-agent', error: 'conflicts merging origin/staging: README.md', agent: 'a1' })
  await clock.advance(2000)
  expect(toasts.at(-1)).toBe('Task #1 needs its agent (a1): conflicts merging origin/staging: README.md')
  expect(status.at(-1)).toBe('tasks: 1 need agent')
  const pane = await $.ui.mount({ plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue', props: { title: 'Tasks', isFocused: true, bodyColumns: 80 } as any })
  expect(await pane.find({ text: 'Needs agent (1)' })).toBeDefined()
  expect(await pane.find({ key: 'merge1' })).toBeUndefined()
  const r = await $.tool.call({ tool: 'mcp__task-queue__task_continue', id: 1 } as any)
  expect(tasks[0].status).toBe('merging')
  expect(JSON.stringify(r)).toContain('merging again')
  const again = await $.tool.call({ tool: 'mcp__task-queue__task_continue', id: 1 } as any)
  expect(JSON.stringify(again)).toContain('Failed')
})

test('the worker prompt: time limits, no processes left behind, and the task\'s agent until it merges', async ($, on) => {
  const { agents } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(agents[0].prompt).toContain('timeout 180')
  expect(agents[0].prompt).toContain('never leave processes behind')
  expect(agents[0].prompt).toContain("You are the task's agent until it merges")
  expect(agents[0].prompt).toContain('task_continue')
})
