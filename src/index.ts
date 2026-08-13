/**
 * dsh-schedule —— host 半区（@dsh-external/dsh-schedule）
 *
 * 功能一：定时任务。按 cron 时间表自动触发 DSH Agent 执行任务（每日摘要、
 * 定时巡检、跑测试并记录）；任务会话日志落盘（侧栏可查），结果登记在
 * 任务记录（$DSH_HOME/schedule.json）。
 *
 * 功能二：状态监控。/status 命令与设置页仪表盘查看系统资源与 harness 状态。
 *
 * 命令组 /schedule：
 *   /schedule list                          —— 任务列表（时间 / 状态 / 下次运行）
 *   /schedule add <时间> <任务内容...>        —— 新增任务（--cwd <目录> 指定工作目录，
 *                                               --desc <备注>；时间格式：分 时 日 月 周）
 *   /schedule remove <id>                   —— 删除任务
 *   /schedule pause <id> | resume <id>      —— 暂停 / 恢复（自动触发）
 *   /schedule run <id>                      —— 立即运行一次
 *
 * 命令组 /status：
 *   /status [agents|sessions]
 *
 * HTTP（设置页数据源，仅本机）：
 *   GET  /dsh-schedule/tasks  ·  POST /dsh-schedule/tasks  ·  GET /dsh-schedule/status
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CronParseError, formatNextRun, nextRun, parseCron } from './cron'
import { ScheduleStore, type ScheduleTask } from './store'
import { createStatusCollector } from './status'
import { createTaskRunner } from './run'
import { cronErrorText, registerHttpRoutes } from './http'

export const name = 'schedule'

export const inject = ['commands', 'webServer', 'loader', 'timer']

export interface Config {
  /** 任务默认工作目录；空 = dsh 进程启动目录。 */
  readonly defaultCwd?: string
  /** 任务默认 provider（覆盖模型选择）；空 = agentDefaultModel.currentSelection()。 */
  readonly defaultProvider?: string
  /** 任务默认模型；空 = agentDefaultModel.currentSelection()。 */
  readonly defaultModel?: string
  /** ticker 间隔秒数（cron 为分钟精度，默认 30s 防跳分钟）。 */
  readonly tickSeconds?: number
  /** 单次任务运行超时毫秒；0 = 不限时。 */
  readonly maxRunMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tokens(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/u).filter((token) => token.length > 0)
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index < 0 || index + 1 >= args.length) return undefined
  return args[index + 1]
}

/**
 * 解析 /schedule add 的 <时间> 参数：支持两种写法
 *   /schedule add 0 9 * * * 任务内容        （5 个裸字段）
 *   /schedule add "0 9 * * *" 任务内容      （引号包裹）
 * 返回 { cron, promptStart }；非法时返回 null（消息见 cronErrorText）。
 */
function parseAddArgs(args: string[]): { cron: string; promptStart: number } | { error: string } {
  const first = args[1] ?? ''
  if (first.startsWith('"')) {
    let end = -1
    for (let i = 1; i < args.length; i += 1) {
      if (args[i]!.endsWith('"')) {
        end = i
        break
      }
    }
    if (end < 0) return { error: '时间参数引号未闭合' }
    const cron = args.slice(1, end + 1).map((part) => part.replaceAll('"', '')).join(' ')
    try {
      parseCron(cron)
    } catch (error) {
      return { error: cronErrorText(error) }
    }
    return { cron, promptStart: end + 1 }
  }
  const cronFields = args.slice(1, 6)
  if (cronFields.length < 5) {
    return { error: cronErrorText(new CronParseError(`cron 需要 5 个字段（分 时 日 月 周），实际 ${cronFields.length} 个`)) }
  }
  const cron = cronFields.join(' ')
  try {
    parseCron(cron)
  } catch (error) {
    return { error: cronErrorText(error) }
  }
  return { cron, promptStart: 6 }
}

/** 从提示词 token 中剔除已消费的 --cwd/--desc 及其值。 */
function buildPrompt(args: string[], start: number): string {
  const parts: string[] = []
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--cwd' || arg === '--desc') {
      i += 1
      continue
    }
    parts.push(arg)
  }
  return parts.join(' ')
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function summarizePrompt(prompt: string): string {
  const single = prompt.replace(/\s+/gu, ' ').trim()
  return single.length > 40 ? `${single.slice(0, 40)}…` : single
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTaskLine(task: ScheduleTask): string {
  let status: string
  if (!task.enabled) {
    status = '暂停'
  } else if (task.lastStatus === 'running') {
    status = '运行中'
  } else if (task.lastStatus === 'error') {
    status = `上次失败（${task.lastError ?? '未知原因'}）`
  } else if (task.lastStatus === 'success') {
    status = `上次成功（${formatMs(task.lastDurationMs ?? 0)}）`
  } else {
    status = '待触发'
  }
  const lines = [`  ${shortId(task.id)}  ${task.cron}  ${status}`]
  lines.push(`     ${summarizePrompt(task.prompt)}`)
  if (task.description !== undefined) lines.push(`     ${task.description}`)
  if (task.cwd !== undefined) lines.push(`     工作目录：${task.cwd}`)
  let schedule: ReturnType<typeof parseCron> | null = null
  try {
    schedule = parseCron(task.cron)
  } catch {
    lines.push('     ⚠ 时间格式无效（可用 /schedule remove <id> 删除后重新添加）')
  }
  if (schedule !== null && task.enabled) {
    lines.push(`     下次运行：${formatNextRun(nextRun(schedule, new Date()))}`)
  }
  if (task.runCount > 0) {
    lines.push(`     已运行 ${task.runCount} 次${task.failCount > 0 ? `（失败 ${task.failCount}）` : ''}`)
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config = {}): void {
  const tickSeconds = Number.isFinite(config.tickSeconds) ? Math.max(5, config.tickSeconds ?? 30) : 30
  const store = new ScheduleStore({ home: resolveDshHome(), logger: ctx.logger })
  const status = createStatusCollector(ctx, resolveDshHome())
  const runner = createTaskRunner(ctx, store, {
    defaultCwd: config.defaultCwd,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    maxRunMs: config.maxRunMs,
  })

  const commandDisposers: Array<() => void> = []

  ctx.effect(() => {
    commandDisposers.push(ctx.commands.register({
      name: 'schedule',
      description: '定时任务：到点自动执行（时间格式：分 时 日 月 周，如 0 9 * * * = 每天 9 点）；子命令 list/add/remove/pause/resume/run',
      input: { hint: 'list | add <时间(如 0 9 * * *)> <任务内容...> | remove <id> | pause <id> | resume <id> | run <id>' },
      handler: async (invocation) => {
        const args = tokens(invocation.rawInput)
        const sub = args[0] ?? ''
        try {
          if (sub === '' || sub === 'list') {
            const tasks = store.list()
            if (tasks.length === 0) {
              return {
                kind: 'success',
                text: '定时任务：无\n添加示例：/schedule add 0 9 * * * 每天 9 点总结昨天的进展（0 9 * * * = 每天 9 点）',
              }
            }
            return { kind: 'success', text: `定时任务（${tasks.length}）：\n${tasks.map(formatTaskLine).join('\n')}` }
          }

          if (sub === 'add') {
            if (args.length < 2) {
              return {
                kind: 'error',
                text: '用法：/schedule add <时间> <任务内容...> [--cwd <目录>] [--desc <备注>]\n时间格式：5 段（分 时 日 月 周），如 0 9 * * * = 每天 9 点',
              }
            }
            const parsed = parseAddArgs(args)
            if ('error' in parsed) return { kind: 'error', text: parsed.error }
            const prompt = buildPrompt(args, parsed.promptStart)
            if (prompt === '') return { kind: 'error', text: '缺少任务内容' }
            const cwd = flagValue(args, '--cwd')
            if (cwd !== undefined && cwd.trim() === '') return { kind: 'error', text: '--cwd 缺少路径' }
            const desc = flagValue(args, '--desc')
            const task = await store.add({
              cron: parsed.cron,
              prompt,
              ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
              ...(desc !== undefined && desc !== '' ? { description: desc } : {}),
            })
            return {
              kind: 'success',
              text: `已添加任务 ${task.id}\n${formatTaskLine(task)}\n立即运行：/schedule run ${task.id}`,
            }
          }

          if (sub === 'remove') {
            const id = args[1] ?? ''
            if (id === '') return { kind: 'error', text: '用法：/schedule remove <id>' }
            const removed = await store.remove(id)
            return removed
              ? { kind: 'success', text: `已删除任务：${id}` }
              : { kind: 'error', text: `任务不存在：${id}` }
          }

          if (sub === 'pause' || sub === 'resume') {
            const id = args[1] ?? ''
            if (id === '') return { kind: 'error', text: `用法：/schedule ${sub} <id>` }
            const enabled = sub === 'resume'
            const task = await store.setEnabled(id, enabled)
            return task === undefined
              ? { kind: 'error', text: `任务不存在：${id}` }
              : { kind: 'success', text: `任务 ${id} 已${enabled ? '恢复' : '暂停'}` }
          }

          if (sub === 'run') {
            const id = args[1] ?? ''
            if (id === '') return { kind: 'error', text: '用法：/schedule run <id>' }
            const result = await runner.runTask(id)
            return result.ok
              ? { kind: 'success', text: result.message }
              : { kind: 'error', text: result.message }
          }

          return {
            kind: 'error',
            text: `未知子命令：${sub}\n用法：/schedule [list|add <时间> <任务内容...>|remove <id>|pause <id>|resume <id>|run <id>]`,
          }
        } catch (error) {
          return { kind: 'error', text: errorMessage(error) }
        }
      },
    }))
    commandDisposers.push(ctx.commands.register({
      name: 'status',
      description: '系统与 harness 综合状态：CPU/内存/磁盘/会话/Agent/插件/模型',
      input: { hint: '[agents | sessions]' },
      handler: (invocation) => {
        const args = tokens(invocation.rawInput)
        const sub = args[0] ?? ''
        if (sub === 'agents') {
          const snap = status.collect()
          return { kind: 'success', text: `Agent：${snap.agents.running} 运行中 / ${snap.agents.total} 总数` }
        }
        if (sub === 'sessions') {
          const snap = status.collect()
          return { kind: 'success', text: `会话：${snap.sessions.live} 个活跃` }
        }
        return { kind: 'success', text: status.render(status.collect()) }
      },
    }))
    commandDisposers.push(registerHttpRoutes(ctx, { store, runner, status }))
    commandDisposers.push(ctx.interval(() => runner.tick(new Date()), tickSeconds * 1000))
    return () => {
      for (const dispose of commandDisposers) dispose()
      commandDisposers.length = 0
    }
  }, 'schedule: app')

  ctx.logger.info('schedule: 定时任务已启用（tick %ds，默认工作目录 %s）', tickSeconds, config.defaultCwd?.trim() || process.cwd())
}
