/**
 * 轻量 cron 表达式解析与匹配（自实现，无外部依赖）。
 *
 * 支持 5 字段（分 时 日 月 周），每字段语法：
 *   *       任意值
 *   42      单个值
 *   1,5,9   列表
 *   1-5     范围（含端点）
 *   *\/15   步进（0 起步）
 *   1-30/5  范围内步进
 *
 * 字段范围：分 0-59，时 0-23，日 1-31，月 1-12，周 0-7（0 与 7 均表示周日）。
 * 周字段按"周日 = 0"规范化；日/月/周三字段同时出现时按 AND 处理（与主流实现一致）。
 */

/** 每字段允许的值范围。 */
const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],  // 分
  [0, 23],  // 时
  [1, 31],  // 日
  [1, 12],  // 月
  [0, 7],   // 周（7 规范化为 0）
]

/** 解析后的 cron：每字段一个值集合（已展开）。 */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** 已规范化（7 → 0）。 */
  readonly daysOfWeek: ReadonlySet<number>
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

/** 展开一个字段表达式为值集合。 */
function expandField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>()
  const parts = field.split(',')
  if (parts.some(part => part.trim() === '')) throw new CronParseError(`字段含空项：'${field}'`)
  for (const part of parts) {
    const stepMatch = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/u.exec(part.trim())
    if (stepMatch === null) throw new CronParseError(`无法解析字段项：'${part}'`)
    const step = stepMatch[3] !== undefined ? parseInt(stepMatch[3], 10) : 1
    if (step <= 0) throw new CronParseError(`步进必须为正数：'${part}'`)

    let from: number
    let to: number
    if (stepMatch[1] === '*') {
      from = min
      to = stepMatch[2] !== undefined ? parseInt(stepMatch[2], 10) : max
    } else {
      from = parseInt(stepMatch[1], 10)
      to = stepMatch[2] !== undefined ? parseInt(stepMatch[2], 10) : from
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new CronParseError(`非整数：'${part}'`)
    if (from > to) throw new CronParseError(`范围起点大于终点：'${part}'`)
    if (from < min || to > max) {
      throw new CronParseError(`值超出范围（${min}-${max}）：'${part}'`)
    }
    for (let value = from; value <= to; value += step) result.add(value)
  }
  return result
}

/** 解析 cron 表达式（5 字段，空白分隔）。 */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) {
    throw new CronParseError(`cron 需要 5 个字段（分 时 日 月 周），实际 ${fields.length} 个：'${expression}'`)
  }
  const sets = fields.map((field, index) => expandField(field, ...FIELD_RANGES[index]!))
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek: new Set([...sets[4]!].map(value => value % 7)),
  }
}

/** 判断某个时间点是否匹配 cron（分钟精度，本地时区）。 */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  return schedule.minutes.has(date.getMinutes())
    && schedule.hours.has(date.getHours())
    && schedule.daysOfMonth.has(date.getDate())
    && schedule.months.has(date.getMonth() + 1)
    && schedule.daysOfWeek.has(date.getDay())
}

/** 扫描上限：4 年，足以覆盖闰年 2 月 29 日等低频 cron。 */
const MAX_SCAN_MINUTES = 4 * 366 * 24 * 60

/** 计算 after 之后（不含 after 本身）的第一个匹配时间；不存在返回 null。 */
export function nextRun(schedule: CronSchedule, after: Date): Date | null {
  const cursor = new Date(after.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  for (let scanned = 0; scanned < MAX_SCAN_MINUTES; scanned += 1) {
    if (cronMatches(schedule, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

/** 渲染下一次运行时间（本地时区，绝对时间）。 */
export function formatNextRun(date: Date | null): string {
  if (date === null) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
