/**
 * "设置 > 插件 > 状态"页签组件 —— 系统资源与 harness 实时仪表盘。
 *
 * 与内置"插件列表"页签同一注册模式：经 slots.register 的 inject 拿到
 * 快照加载函数，组件每 5 秒轮询并渲染（可手动暂停/恢复）。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 与 host 路由 GET /dsh-schedule/status 的响应同形。 */
export interface StatusSnapshot {
  readonly at: number
  readonly uptimeSeconds: number
  readonly pid: number
  readonly nodeVersion: string
  readonly platform: string
  readonly cwd: string
  readonly cpu: { readonly usagePercent: number | null; readonly cores: number }
  readonly memory: {
    readonly totalBytes: number
    readonly freeBytes: number
    readonly usedBytes: number
    readonly usagePercent: number
  }
  readonly disk: {
    readonly totalBytes: number | null
    readonly freeBytes: number | null
    readonly usagePercent: number | null
  }
  readonly sessions: { readonly live: number }
  readonly agents: { readonly total: number; readonly running: number }
  readonly plugins: { readonly installed: number }
  readonly model: { readonly provider: string; readonly model: string } | null
}

/** 页签注册时注入的数据函数。 */
export interface StatusTabInjected {
  load: () => Promise<StatusSnapshot>
}

/** Slot 渲染器组装出的完整组件 props。 */
export type StatusSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.scheduleStatus'>
  & InjectFace<StatusTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly snapshot: StatusSnapshot }

const REFRESH_MS = 5000

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, padding: 10, border: '1px solid #3a3a3f',
  borderRadius: 8, marginBottom: 8,
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const label: CSSProperties = { fontWeight: 600, minWidth: 120, margin: 0 }
const dim: CSSProperties = { color: '#9b9ba0', fontSize: 12 }
const barTrack: CSSProperties = { flex: 1, height: 8, borderRadius: 4, background: '#2a2a2f', overflow: 'hidden' }
const barFill: CSSProperties = { height: '100%', borderRadius: 4, background: '#4a8fe0' }
const chip: CSSProperties = {
  fontSize: 11, padding: '1px 8px', borderRadius: 10, border: '1px solid #55555c', color: '#c6c6cc',
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}

function formatDuration(seconds: number): string {
  const parts: string[] = []
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (days > 0) parts.push(`${days}d`)
  if (days > 0 || hours > 0) parts.push(`${hours}h`)
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)
  return parts.join(' ')
}

function Bar({ percent, label }: { percent: number; label: string }): ReactNode {
  return (
    <div style={barTrack} role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ ...barFill, width: `${percent}%` }} />
    </div>
  )
}

/** 渲染"设置 > 插件 > 状态"仪表盘页签。 */
export function StatusSettingsTab({ load, t }: StatusSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [paused, setPaused] = useState(false)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = (): void => {
      void load().then(
        (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
        (error) => { if (current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
      )
    }
    tick()
    if (!paused) timer = setInterval(tick, REFRESH_MS)
    return () => {
      current = false
      if (timer !== undefined) clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load 由注册侧注入，稳定
  }, [load, request, paused])

  const retry = (): void => { setState({ status: 'loading' }); setRequest(v => v + 1) }

  if (state.status === 'loading') {
    return <p style={dim}>{t('loading')}</p>
  }
  if (state.status === 'error') {
    return (
      <div>
        <p role="alert">{t('error')}</p>
        <p style={dim}>{state.message}</p>
        <button type="button" onClick={retry}>{t('retry')}</button>
      </div>
    )
  }

  const snap = state.snapshot
  const diskFree = snap.disk.freeBytes
  const diskTotal = snap.disk.totalBytes
  const diskUsage = snap.disk.usagePercent
  const diskReady = diskFree !== null && diskTotal !== null && diskUsage !== null
  const cpuLabel = snap.cpu.usagePercent === null ? t('cpuSampling') : `${snap.cpu.usagePercent.toFixed(1)}%`

  return (
    <div>
      <div style={row}>
        <span style={dim}>{paused ? t('autoRefreshPaused') : t('autoRefresh')}</span>
        <button
          type="button"
          aria-label={paused ? t('resumeRefresh') : t('pauseRefresh')}
          title={paused ? t('resumeRefresh') : t('pauseRefresh')}
          onClick={() => setPaused(v => !v)}
        >
          {paused ? '▶' : '⏸'}
        </button>
      </div>

      <div style={card}>
        <p style={label}>{t('process')}</p>
        <p style={dim}>{t('uptime')}: {formatDuration(snap.uptimeSeconds)} · PID {snap.pid} · {snap.platform} · Node {snap.nodeVersion}</p>
        <p style={dim}>{t('cwd')}: {snap.cwd}</p>
      </div>

      <div style={card}>
        <div style={row}>
          <p style={label}>{t('cpu')}</p>
          <span>{cpuLabel}</span>
          <span style={dim}>{snap.cpu.cores} {t('cores')}</span>
          <div style={{ flex: 1 }} />
          {snap.cpu.usagePercent === null
            ? null
            : <Bar percent={snap.cpu.usagePercent} label={t('cpu')} />}
        </div>
        <div style={row}>
          <p style={label}>{t('memory')}</p>
          <span>{formatBytes(snap.memory.usedBytes)} / {formatBytes(snap.memory.totalBytes)}</span>
          <span style={dim}>{snap.memory.usagePercent.toFixed(1)}%</span>
          <div style={{ flex: 1 }} />
          <Bar percent={snap.memory.usagePercent} label={t('memory')} />
        </div>
        <div style={row}>
          <p style={label}>{t('disk')}</p>
          {diskReady && diskFree !== null && diskTotal !== null && diskUsage !== null
            ? (
              <>
                <span>{formatBytes(diskFree)} / {formatBytes(diskTotal)}</span>
                <span style={dim}>{diskUsage.toFixed(1)}%</span>
                <div style={{ flex: 1 }} />
                <Bar percent={diskUsage} label={t('disk')} />
              </>
            )
            : <span style={dim}>{t('diskUnavailable')}</span>}
        </div>
      </div>

      <div style={card}>
        <div style={row}>
          <p style={label}>{t('sessions')}</p>
          <span>{snap.sessions.live}</span>
        </div>
        <div style={row}>
          <p style={label}>{t('agents')}</p>
          <span>{snap.agents.running} {t('agentsRunning')} / {snap.agents.total}</span>
        </div>
        <div style={row}>
          <p style={label}>{t('plugins')}</p>
          <span>{snap.plugins.installed}</span>
        </div>
        <div style={row}>
          <p style={label}>{t('model')}</p>
          {snap.model === null
            ? <span style={dim}>{t('modelUnconfigured')}</span>
            : <span style={chip}>{snap.model.provider}/{snap.model.model}</span>}
        </div>
      </div>
    </div>
  )
}
