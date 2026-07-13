import type { IpcHandle } from './registration'
import type { TaskCreateArgs, TaskListResult, TaskRecord } from '../types'

export type TaskIpcService = {
  listTasks: () => TaskListResult
  getTask: (id: string) => TaskRecord | null
  updateToolRunImages: (taskId: string, runId: string, imagePaths: string[]) => TaskRecord | null
  createTask: (args: TaskCreateArgs) => TaskRecord
  pauseTask: (id: string) => TaskRecord | null
  resumeTask: (id: string) => TaskRecord | null
  cancelTask: (id: string) => TaskRecord | null
  dismissTask: (id: string) => { ok: true } | null
}

export type TaskIpcDependencies = {
  handle: IpcHandle
  getTaskService: () => TaskIpcService | null
}

export function registerTaskIpc({ handle, getTaskService }: TaskIpcDependencies): void {
  handle('task:list', (): TaskListResult => getTaskService()?.listTasks() ?? { items: [] })
  handle('task:get', (_event, id: string): TaskRecord | null => getTaskService()?.getTask(id) ?? null)
  handle(
    'task:updateToolRunImages',
    (_event, taskId: string, runId: string, imagePaths: string[]): TaskRecord | null =>
      getTaskService()?.updateToolRunImages(taskId, runId, imagePaths) ?? null,
  )
  handle('task:create', (_event, args: TaskCreateArgs): TaskRecord => {
    const taskService = getTaskService()
    if (!taskService) throw new Error('Task service not ready')
    return taskService.createTask(args)
  })
  handle('task:pause', (_event, id: string): TaskRecord | null => getTaskService()?.pauseTask(id) ?? null)
  handle('task:resume', (_event, id: string): TaskRecord | null => getTaskService()?.resumeTask(id) ?? null)
  handle('task:cancel', (_event, id: string): TaskRecord | null => getTaskService()?.cancelTask(id) ?? null)
  handle('task:dismiss', (_event, id: string): { ok: true } | null => getTaskService()?.dismissTask(id) ?? null)
}
