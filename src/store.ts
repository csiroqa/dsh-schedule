/**
 * 定时任务持久化存储 —— JSON 文件（$DSH_HOME/schedule.json）。
 *
 * 写入串行化（操作尾链）：所有写操作在首轮文件加载完成后才执行，
 * 避免启动期"未读到旧任务就覆盖写盘"的数据丢失；读/解析失败时以空表
 * 继续（损坏文件保留原位以便排查），并记一条警告日志。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 最小日志接口（由插件注入 ctx.logger）。 */
export interface ScheduleStoreLogger {
  warn(message: string, ...args: unknown[]): void
}

/** 持久化任务记录。 */
export interface ScheduleTask {
  readonly id: string
  /** 5 字段 cron 表达式。 */
  readonly cron: string
  /** 触发时交给 agent 执行的任务内容。 */
  readonly prompt: string
  /** 可选备注。 */
  readonly description?: string
  /** 任务工作目录（agent 的 cwd / workspace 归属）；空 = 用插件默认。 */
  readonly cwd?: string
  readonly enabled: boolean
  readonly createdAt: number
  readonly lastRunAt?: number
  readonly lastStatus?: 'success' | 'error' | 'running'
  readonly lastError?: string
  readonly lastDurationMs?: number
  readonly runCount: number
  readonly failCount: number
}

export interface ScheduleStoreOptions {
  /** $DSH_HOME 路径。 */
  home: string
  /** 警告日志通道（读文件失败等）。 */
  logger: ScheduleStoreLogger
}

/** 一个任务的持久化布局（不含只读派生字段）。 */
type TaskDraft = Omit<ScheduleTask, 'id' | 'createdAt' | 'enabled' | 'runCount' | 'failCount' | 'lastRunAt' | 'lastStatus' | 'lastError' | 'lastDurationMs'>

function sanitize(raw: unknown): ScheduleTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: ScheduleTask[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.cron !== 'string' || typeof record.prompt !== 'string') continue
    const id = record.id
    const enabled = record.enabled === true
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
    const description = typeof record.description === 'string' && record.description !== '' ? record.description : undefined
    const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
    const lastRunAt = typeof record.lastRunAt === 'number' ? record.lastRunAt : undefined
    const lastStatus = record.lastStatus === 'success' || record.lastStatus === 'error' || record.lastStatus === 'running'
      ? record.lastStatus
      : undefined
    const lastError = typeof record.lastError === 'string' ? record.lastError : undefined
    const lastDurationMs = typeof record.lastDurationMs === 'number' ? record.lastDurationMs : undefined
    const runCount = typeof record.runCount === 'number' ? record.runCount : 0
    const failCount = typeof record.failCount === 'number' ? record.failCount : 0
    tasks.push({
      id, cron: record.cron, prompt: record.prompt,
      ...(description !== undefined ? { description } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      enabled, createdAt,
      ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      ...(lastStatus !== undefined ? { lastStatus } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastDurationMs !== undefined ? { lastDurationMs } : {}),
      runCount, failCount,
    })
  }
  return tasks
}

/** 定时任务存储：内存镜像 + 串行化 JSON 落盘。 */
export class ScheduleStore {
  private tasks = new Map<string, ScheduleTask>()
  private readonly path: string
  private readonly logger: ScheduleStoreLogger
  private operationTail: Promise<void>

  constructor(options: ScheduleStoreOptions) {
    this.path = join(options.home, 'schedule.json')
    this.logger = options.logger
    // 写链首尾接上首轮加载：任何写操作都会等 load() 完成，
    // 保证不会用"未加载旧任务的内存"覆盖磁盘。
    this.operationTail = this.load()
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      for (const task of sanitize(raw)) this.tasks.set(task.id, task)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'ENOENT') {
        this.logger.warn('schedule: 读取任务文件失败（%s）：%s', this.path, error instanceof Error ? error.message : String(error))
      }
    }
  }

  list(): readonly ScheduleTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): ScheduleTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * 等待当前写链（含首轮文件加载）排空。
   * 测试与优雅关闭场景使用：保证此前入队的读/写操作已生效。
   */
  flush(): Promise<void> {
    return this.operationTail
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.list(), null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, this.path)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  add(draft: TaskDraft): Promise<ScheduleTask> {
    return this.enqueue(async () => {
      const task: ScheduleTask = {
        id: randomUUID(),
        ...draft,
        createdAt: Date.now(),
        enabled: true,
        runCount: 0,
        failCount: 0,
      }
      this.tasks.set(task.id, task)
      await this.persist()
      return task
    })
  }

  remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const removed = this.tasks.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<ScheduleTask | undefined> {
    return this.enqueue(async () => {
      const task = this.tasks.get(id)
      if (task === undefined) return undefined
      const next = { ...task, enabled }
      this.tasks.set(id, next)
      await this.persist()
      return next
    })
  }

  /** 记录运行开始（running 状态）。 */
  markRunning(id: string): Promise<ScheduleTask | undefined> {
    return this.enqueue(async () => {
      const task = this.tasks.get(id)
      if (task === undefined) return undefined
      const next = { ...task, lastStatus: 'running' as const }
      this.tasks.set(id, next)
      await this.persist()
      return next
    })
  }

  /** 记录一次运行结果（成功时清掉上次的失败原因，避免陈旧信息）。 */
  recordRun(
    id: string,
    outcome: { status: 'success' | 'error'; error?: string; durationMs: number; runAt: number },
  ): Promise<ScheduleTask | undefined> {
    return this.enqueue(async () => {
      const task = this.tasks.get(id)
      if (task === undefined) return undefined
      const next: ScheduleTask = {
        ...task,
        lastRunAt: outcome.runAt,
        lastStatus: outcome.status,
        lastError: outcome.status === 'error' ? (outcome.error ?? '未知错误') : undefined,
        lastDurationMs: outcome.durationMs,
        runCount: task.runCount + 1,
        failCount: task.failCount + (outcome.status === 'error' ? 1 : 0),
      }
      this.tasks.set(id, next)
      await this.persist()
      return next
    })
  }
}
