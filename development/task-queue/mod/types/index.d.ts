/** A task as the queue's API (development/task-queue/server.ts) returns it, the fields the pane draws. */
export type Task = {
  id: number
  title: string
  status: 'queued' | 'working' | 'complete' | 'merging' | 'merged' | 'failed' | 'discarded'
  branch?: string
  url?: string
  previewUp?: boolean
  error?: string
  last?: string
  commit?: string
  updatedAt: string
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
