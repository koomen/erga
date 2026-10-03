import { expect, test } from 'claude-code/testing'

// The engine beneath the mod, faked: a repo with a task queue at /repo, a queue
// that answers from memory, and a spawn that always starts.
function fakeQueue(on: any) {
  const tasks: any[] = []
  const spawned: any[] = []
  on('process.run', (_$: any, e: any) =>
    e.argv[0] === 'git' ? { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' })
  on('fs.stat', () => ({ type: 'file', size: 1, mtimeMs: 0 }))
  on('agent.spawn', (_$: any, e: any) => { spawned.push(e); return { model: 'm', agentId: 'a1' } })
  on('http.fetch', (_$: any, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('http://127.0.0.1:4700', '')
    const body = e.init?.body ? JSON.parse(e.init.body) : {}
    const ok = (data: unknown, status = 200) => ({ status, ok: true, headers: {}, text: JSON.stringify(data) })
    if (method === 'POST' && path === '/api/tasks') {
      const t = { id: tasks.length + 1, title: body.title, description: body.description, status: 'queued', worktree: `/repo/.claude/worktrees/task-${tasks.length + 1}`, branch: 'task/1-x', port: 4501, log: [], updatedAt: new Date().toISOString() }
      tasks.push(t)
      return ok(t, 201)
    }
    const m = path.match(/^\/api\/tasks\/(\d+)/)
    const t = m ? tasks[Number(m[1]) - 1] : undefined
    if (method === 'PATCH' && t) { Object.assign(t, body); return ok(t) }
    if (method === 'POST' && t) { if (body.message) t.log.push({ message: body.message }); return ok(t) }
    return ok(tasks)
  })
  return { tasks, spawned }
}

test('task_create registers the task and starts a worker in its worktree', async ($, on) => {
  const { tasks, spawned } = fakeQueue(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__task-queue__task_create', title: 'Add a thing', ask: 'Please add a thing' } as any)
  expect(tasks).toHaveLength(1)
  expect(tasks[0].status).toBe('working')
  expect(spawned[0].subagentType).toBe('task-queue:worker')
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
