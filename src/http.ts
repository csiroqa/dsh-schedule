/**
 * HTTP 接口层 —— dsh-schedule 的 host 侧子模块。
 *
 * 设置页数据源与操作入口（仅监听本机，DSH 默认回环绑定）：
 *   GET  /dsh-schedule/tasks   任务列表
 *   POST /dsh-schedule/tasks   {action: add|remove|pause|resume|run, ...}
 *   GET  /dsh-schedule/status  状态快照
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { parseCron, CronParseError, formatNextRun, nextRun } from './cron'
import { type ScheduleStore, type ScheduleTask } from './store'
import { type StatusCollector } from './status'
import { type TaskRunner } from './run'

const MAX_BODY_BYTES = 64 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 读取请求体（上限 64KB）；超限排空剩余流后抛错。 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      break
    }
    chunks.push(buffer)
  }
  if (tooLarge) {
    req.resume() // 排空剩余数据，避免 keep-alive 连接残留
    throw new Error('请求内容过大（上限 64KB）')
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw new Error('请求内容格式错误，请重试')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('请求内容格式错误，请重试')
    throw error
  }
}

function taskView(task: ScheduleTask): unknown {
  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    description: task.description,
    cwd: task.cwd,
    enabled: task.enabled,
    createdAt: task.createdAt,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    lastDurationMs: task.lastDurationMs,
    runCount: task.runCount,
    failCount: task.failCount,
    nextRunAt: task.enabled ? nextRunSafe(task.cron) : null,
  }
}

function nextRunSafe(cron: string): number | null {
  try {
    return nextRun(parseCron(cron), new Date())?.getTime() ?? null
  } catch {
    return null
  }
}

export interface HttpRoutesOptions {
  store: ScheduleStore
  runner: TaskRunner
  status: StatusCollector
}

/** 注册 /dsh-schedule/* 路由；返回 disposer（卸载时移除两条路由）。 */
export function registerHttpRoutes(ctx: Context, options: HttpRoutesOptions): () => void {
  const { store, runner, status } = options

  const handleTasks = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      respond(res, 200, { ok: true, tasks: store.list().map(taskView) })
      return
    }
    if (method !== 'POST') {
      respond(res, 405, { ok: false, message: `不支持的请求方式（${method}）` })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (error) {
      respond(res, 400, { ok: false, message: errorMessage(error) })
      return
    }
    const action = body.action
    try {
      if (action === 'add') {
        const cron = typeof body.cron === 'string' ? body.cron.trim() : ''
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (cron === '' || prompt === '') {
          respond(res, 400, { ok: false, message: '触发时间与任务内容为必填项' })
          return
        }
        try {
          parseCron(cron)
        } catch (error) {
          respond(res, 400, { ok: false, message: cronErrorText(error) })
          return
        }
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : undefined
        if (cwd !== undefined) {
          const info = await stat(cwd).catch(() => null)
          if (info === null || !info.isDirectory()) {
            respond(res, 400, { ok: false, message: `工作目录不存在：${cwd}` })
            return
          }
        }
        const description = typeof body.description === 'string' && body.description.trim() !== '' ? body.description.trim() : undefined
        const task = await store.add({
          cron,
          prompt,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(description !== undefined ? { description } : {}),
        })
        respond(res, 200, { ok: true, message: `已添加任务 ${task.id}`, tasks: store.list().map(taskView) })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        respond(res, 400, { ok: false, message: '缺少任务 id' })
        return
      }
      if (action === 'remove') {
        const removed = await store.remove(id)
        respond(res, removed ? 200 : 404, {
          ok: removed,
          message: removed ? `已删除任务 ${id}` : `任务不存在：${id}`,
          tasks: store.list().map(taskView),
        })
        return
      }
      if (action === 'pause' || action === 'resume') {
        const task = await store.setEnabled(id, action === 'resume')
        respond(res, task !== undefined ? 200 : 404, {
          ok: task !== undefined,
          message: task !== undefined ? `任务 ${id} 已${action === 'resume' ? '恢复' : '暂停'}` : `任务不存在：${id}`,
          tasks: store.list().map(taskView),
        })
        return
      }
      if (action === 'run') {
        const result = await runner.runTask(id)
        respond(res, result.ok ? 200 : 400, {
          ok: result.ok,
          message: result.message,
          tasks: store.list().map(taskView),
        })
        return
      }
      respond(res, 400, { ok: false, message: `不支持的操作：${String(action)}` })
    } catch (error) {
      respond(res, 400, { ok: false, message: errorMessage(error) })
    }
  }

  const handleStatus = (_req: IncomingMessage, res: ServerResponse): void => {
    respond(res, 200, status.collect())
  }

  const disposeTasks = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-schedule/tasks',
    handler: handleTasks,
  })
  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-schedule/status',
    handler: handleStatus,
  })
  return () => {
    disposeTasks()
    disposeStatus()
  }
}

function cronErrorText(error: unknown): string {
  if (error instanceof CronParseError) {
    return `时间格式无效：${error.message}。格式为 5 段（分 时 日 月 周），示例 0 9 * * * 表示每天 9 点`
  }
  return errorMessage(error)
}

export { cronErrorText, formatNextRun }
