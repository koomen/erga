/** A task as the queue's API (development/task-queue/server.ts) returns it, the fields the pane draws. */
export type Task = {
  id: number
  title: string
  status: 'queued' | 'working' | 'complete' | 'merging' | 'needs-agent' | 'merged' | 'failed' | 'discarded'
  branch?: string
  url?: string
  previewUp?: boolean
  /** Worked on live, in a session with the user (its own dev server and Chrome window), not by a worker. */
  live?: boolean
  error?: string
  /** The agent doing the task, from start until merge: the one to wake when its merge needs work (needs-agent). */
  agent?: string
  last?: string
  commit?: string
  updatedAt: string
  /** Don't start until these tasks are merged. */
  startAfter?: number[]
  /** Don't merge until these tasks are merged. */
  mergeAfter?: number[]
  /** What the task waits for (computed by the queue), absent when nothing blocks it. */
  blockedBy?: { start: number[]; merge: number[]; stuck: number[]; reason: string }
}

declare module 'claude-code' {
  interface PluginState {
    'task-queue': {
      tasks: Task[]
      /** Whether the queue's server answered the last poll. */
      isOnline: boolean
      /** The task whose Discard was pressed once, waiting for the second press. */
      armed: number | null
    }
  }
}
