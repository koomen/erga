import { expect, mock, test } from 'claude-code/testing'

// The engine beneath the mod, faked: a repo with a task queue at /repo, a queue
// that answers from memory, a spawn that always starts, and toasts and the
// status line kept for the test to read.
function fakeQueue(on: any) {
  const tasks: any[] = []
  const spawned: any[] = []
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
  on('agent.register', (_$: any, e: any) => ({ value: { agent: `task-queue:${e.name}` } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { shown: true } }))
  on('agent.spawn', (_$: any, e: any) => { spawned.push(e); return { model: 'm', agentId: 'a1' } })
  on('http.fetch', (_$: any, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('http://127.0.0.1:4700', '')
    const body = e.init?.body ? JSON.parse(e.init.body) : {}
    const ok = (data: unknown, status = 200) => ({ value: { status, ok: true, headers: {}, text: JSON.stringify(data) } })
    if (method === 'POST' && path === '/api/tasks') {
      const t = { id: tasks.length + 1, title: body.title, description: body.description, status: 'queued', worktree: `/repo/.claude/worktrees/task-${tasks.length + 1}`, branch: 'task/1-x', port: 4501, log: [], updatedAt: new Date().toISOString() }
      tasks.push(t)
      return ok(t, 201)
    }
    const m = path.match(/^\/api\/tasks\/(\d+)/)
    const t = m ? tasks[Number(m[1]) - 1] : undefined
    if (method === 'PATCH' && t) { Object.assign(t, body); return ok(t) }
    if (method === 'POST' && t && path.endsWith('/merge')) {
      if (t.status !== 'complete') return { value: { status: 409, ok: false, headers: {}, text: JSON.stringify({ error: `task ${t.id} is ${t.status}, not complete` }) } }
      t.status = 'merging'
      return ok(t, 202)
    }
    if (method === 'POST' && t) { if (body.message) t.log.push({ message: body.message }); return ok(t) }
    return ok(tasks)
  })
  return { tasks, spawned, toasts, status, clock }
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
})

test('task_done marks the task complete', async ($, on) => {
  const { tasks } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'X', ask: 'Y' } as any)
  await $.tool.call({ tool: 'mcp__task-queue__task_done', id: 1, summary: 'Did it' } as any)
  expect(tasks[0].status).toBe('complete')
  expect(tasks[0].summary).toBe('Did it')
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
