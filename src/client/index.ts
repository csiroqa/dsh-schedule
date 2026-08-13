/**
 * dsh-schedule —— browser 半区
 *
 * 在"设置 > 插件"区段注册两个页签（slot: settings.plugins.tab）：
 *  - "定时任务"（id: schedule，order 20）：经 GET/POST /dsh-schedule/tasks
 *    浏览任务、增删、暂停/恢复、立即运行。
 *  - "状态"（id: status，order 10）：轮询 GET /dsh-schedule/status
 *    渲染系统与 harness 实时仪表盘。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ScheduleSettingsTab, type ScheduleTabInjected, type ScheduleTaskView } from './ScheduleSettingsTab'
import { StatusSettingsTab, type StatusTabInjected } from './StatusSettingsTab'
import { en as scheduleEn, zh as scheduleZh, type ScheduleLocaleKey } from './locales'
import { en as statusEn, zh as statusZh, type StatusLocaleKey } from './status-locales'

export const name = 'schedule-client'

/** 定时任务页签文案命名空间。 */
export const NS_SCHEDULE = 'settings.schedule'
/** 状态页签文案命名空间。 */
export const NS_STATUS = 'settings.scheduleStatus'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 定时任务页签文案。 */
    'settings.schedule': ScheduleLocaleKey
    /** 状态仪表盘页签文案。 */
    'settings.scheduleStatus': StatusLocaleKey
  }
}

export const inject = ['slots', 'locale']

const FETCH_TIMEOUT_MS = 10_000

/** 统一 fetch：超时 + 服务端错误消息透传。 */
async function fetchJson(input: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(input, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  })
  let body: unknown
  try {
    body = await res.json() as unknown
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body }
}

/** 从载荷中取服务端 message；没有则给出带状态码的通用错误。 */
function serverMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return `HTTP ${status}`
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS_SCHEDULE, { zh: scheduleZh, en: scheduleEn }), 'schedule: schedule dictionaries')
  ctx.effect(() => ctx.locale.register(NS_STATUS, { zh: statusZh, en: statusEn }), 'schedule: status dictionaries')

  const tSchedule = ctx.locale.bind(NS_SCHEDULE)
  const scheduleInjected = (): ScheduleTabInjected => ({
    list: async () => {
      const result = await fetchJson('/dsh-schedule/tasks')
      if (!result.ok) {
        throw new Error(`${tSchedule('errorFetch')}（${serverMessage(result.body, result.status)}）`)
      }
      const payload = result.body as { ok?: boolean; tasks?: readonly ScheduleTaskView[] }
      if (payload.ok === false || !Array.isArray(payload.tasks)) {
        throw new Error(tSchedule('errorFetch'))
      }
      return payload.tasks
    },
    action: async (body) => {
      const result = await fetchJson('/dsh-schedule/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = result.body as { ok?: boolean; message?: string; tasks?: readonly ScheduleTaskView[] }
      if (!result.ok) {
        throw new Error(serverMessage(result.body, result.status))
      }
      if (payload.ok === false || !Array.isArray(payload.tasks)) {
        throw new Error(serverMessage(result.body, result.status) || tSchedule('errorFetch'))
      }
      return { message: payload.message ?? '', tasks: payload.tasks }
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'schedule',
    order: 20,
    label: () => tSchedule('tab'),
    locale: NS_SCHEDULE,
    inject: scheduleInjected,
  }, ScheduleSettingsTab))

  const tStatus = ctx.locale.bind(NS_STATUS)
  const statusInjected = (): StatusTabInjected => ({
    load: async () => {
      const result = await fetchJson('/dsh-schedule/status')
      if (!result.ok) {
        throw new Error(`${tStatus('error')}（${serverMessage(result.body, result.status)}）`)
      }
      return result.body as import('./StatusSettingsTab').StatusSnapshot
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'status',
    order: 10,
    label: () => tStatus('tab'),
    locale: NS_STATUS,
    inject: statusInjected,
  }, StatusSettingsTab))
}
