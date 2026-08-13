/**
 * "设置 > 插件 > 定时任务"页签组件 —— 任务列表 + 添加表单 + 操作按钮。
 *
 * 与内置"插件列表"页签同一注册模式：经 slots.register 的 inject 拿到
 * list/action 数据函数，组件只做展示与表单交互。
 */
import { useEffect, useId, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 与 host GET /dsh-schedule/tasks 的条目同形。 */
export interface ScheduleTaskView {
  readonly id: string
  readonly cron: string
  readonly prompt: string
  readonly description?: string
  readonly cwd?: string
  readonly enabled: boolean
  readonly createdAt: number
  readonly lastRunAt?: number
  readonly lastStatus?: 'success' | 'error' | 'running'
  readonly lastError?: string
  readonly lastDurationMs?: number
  readonly runCount: number
  readonly failCount: number
  /** host 计算的最近一次匹配时间（毫秒时间戳）；无效 cron 时为 null。 */
  readonly nextRunAt: number | null
}

/** 页签注册时注入的数据函数。 */
export interface ScheduleTabInjected {
  list: () => Promise<readonly ScheduleTaskView[]>
  action: (body: {
    action: 'add' | 'remove' | 'pause' | 'resume' | 'run'
    id?: string
    cron?: string
    prompt?: string
    cwd?: string
    description?: string
  }) => Promise<{ message: string; tasks: readonly ScheduleTaskView[] }>
}

/** Slot 渲染器组装出的完整组件 props。 */
export type ScheduleSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.schedule'>
  & InjectFace<ScheduleTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly tasks: readonly ScheduleTaskView[] }

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid #3a3a3f',
  borderRadius: 8, marginBottom: 8,
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const title: CSSProperties = { fontWeight: 600, margin: 0, minWidth: 0, flex: 1 }
const dim: CSSProperties = { color: '#9b9ba0', fontSize: 12 }
const mono: CSSProperties = { fontFamily: 'monospace', fontSize: 12 }
const field: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160,
}
const input: CSSProperties = {
  padding: '4px 8px', borderRadius: 6, border: '1px solid #55555c', background: '#1e1e22',
  color: '#e6e6ea', fontSize: 13,
}
const textarea: CSSProperties = { ...input, minHeight: 56, resize: 'vertical' }
const tag: CSSProperties = {
  fontSize: 11, padding: '1px 8px', borderRadius: 10, border: '1px solid #55555c', color: '#c6c6cc',
}
const successTag: CSSProperties = { ...tag, borderColor: '#2f7d4f', color: '#6fce93' }
const errorTag: CSSProperties = { ...tag, borderColor: '#a13b3b', color: '#e08a8a' }
const runningTag: CSSProperties = { ...tag, borderColor: '#4a8fe0', color: '#8ab8f2' }
const pausedTag: CSSProperties = { ...tag, borderColor: '#8a6d2f', color: '#d4b06a' }
const button: CSSProperties = {
  padding: '3px 10px', borderRadius: 6, border: '1px solid #55555c', background: 'transparent',
  color: '#c6c6cc', cursor: 'pointer',
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function summarize(text: string, max: number): string {
  const single = text.replace(/\s+/gu, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/** 渲染"设置 > 插件 > 定时任务"页签。 */
export function ScheduleSettingsTab({ list, action, t }: ScheduleSettingsTabProps): ReactNode {
  const cronId = useId()
  const promptId = useId()
  const cwdId = useId()
  const descId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [cron, setCron] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let current = true
    void list().then(
      (tasks) => { if (current) setState({ status: 'ready', tasks }) },
      (error) => { if (current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list 由注册侧注入，稳定
  }, [list, request])

  const retry = (): void => { setState({ status: 'loading' }); setRequest(v => v + 1) }

  const perform = async (body: Parameters<ScheduleTabInjected['action']>[0]): Promise<void> => {
    setBusy(true)
    try {
      const result = await action(body)
      setState({ status: 'ready', tasks: result.tasks })
      setNotice({ kind: 'info', text: result.message })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    setNotice(null)
    void perform({
      action: 'add', cron, prompt,
      ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
      ...(desc.trim() !== '' ? { description: desc.trim() } : {}),
    }).then(() => {
      setCron('0 9 * * *')
      setPrompt('')
      setCwd('')
      setDesc('')
    })
  }

  const statusTag = (task: ScheduleTaskView): ReactNode => {
    if (!task.enabled) return <span style={pausedTag}>{t('paused')}</span>
    if (task.lastStatus === 'running') return <span style={runningTag}>{t('running')}</span>
    if (task.lastStatus === 'error') return <span style={errorTag}>{t('errorLast')}</span>
    if (task.lastStatus === 'success') return <span style={successTag}>{t('success')}</span>
    return <span style={tag}>{t('pending')}</span>
  }

  const runSummary = (task: ScheduleTaskView): string => {
    const parts: string[] = []
    if (task.runCount > 0) {
      const fail = task.failCount > 0 ? (t('runs') === 'Runs' ? ` (${task.failCount} ${t('failed')})` : `（${t('failed')} ${task.failCount}）`) : ''
      parts.push(`${t('runs')} ${task.runCount}${fail}`)
    }
    if (task.lastRunAt !== undefined) {
      const when = formatTime(task.lastRunAt)
      if (task.lastStatus === 'success' || task.lastStatus === 'error') {
        const label = task.lastStatus === 'success' ? t('success') : t('errorLast')
        parts.push(`${label} ${when}${task.lastDurationMs !== undefined ? ` · ${formatDuration(task.lastDurationMs)}` : ''}`)
      } else {
        parts.push(`${t('running')} ${when}`)
      }
    }
    return parts.join(' · ')
  }

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

  return (
    <div aria-busy={busy}>
      {notice !== null
        ? <p role={notice.kind === 'error' ? 'alert' : 'status'} style={notice.kind === 'error' ? { color: '#e08a8a' } : dim}>{notice.text}</p>
        : null}

      <form style={card} onSubmit={onSubmit}>
        <p style={title}>{t('add')}</p>
        <div style={row}>
          <div style={field}>
            <label htmlFor={cronId}>{t('cronLabel')}</label>
            <input id={cronId} style={input} value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" required />
            <span style={dim}>{t('addHint')}</span>
          </div>
          <div style={field}>
            <label htmlFor={promptId}>{t('promptLabel')}</label>
            <textarea id={promptId} style={textarea} value={prompt} onChange={e => setPrompt(e.target.value)} required />
          </div>
        </div>
        <div style={row}>
          <div style={field}>
            <label htmlFor={cwdId}>{t('cwdLabel')}</label>
            <input id={cwdId} style={input} value={cwd} onChange={e => setCwd(e.target.value)} />
          </div>
          <div style={field}>
            <label htmlFor={descId}>{t('descLabel')}</label>
            <input id={descId} style={input} value={desc} onChange={e => setDesc(e.target.value)} />
          </div>
        </div>
        <div>
          <button type="submit" style={{ ...button, padding: '5px 16px' }} disabled={busy}>{t('addSubmit')}</button>
        </div>
      </form>

      {state.tasks.length === 0
        ? (
          <div style={card}>
            <p style={dim}>{t('empty')}</p>
            <p style={mono}>{t('emptyExample')}</p>
          </div>
        )
        : state.tasks.map(task => {
          const taskBusy = busy || task.lastStatus === 'running'
          return (
            <div key={task.id} style={card}>
              <div style={row}>
                <p style={title}>{summarize(task.prompt, 60)}</p>
                {statusTag(task)}
              </div>
              {task.description !== undefined ? <p style={dim}>{task.description}</p> : null}
              <div style={row}>
                <span style={mono}>{task.cron}</span>
                {task.cwd !== undefined ? <span style={mono}>{task.cwd}</span> : null}
                {task.nextRunAt !== null && task.enabled ? <span style={dim}>{t('nextRun')}: {formatTime(task.nextRunAt)}</span> : null}
              </div>
              {task.lastStatus === 'error' && task.lastError !== undefined
                ? <p style={dim}>{summarize(task.lastError, 120)}</p>
                : null}
              <div style={row}>
                <span style={dim}>{runSummary(task)}</span>
                <span style={{ flex: 1 }} />
                <button type="button" style={button} disabled={taskBusy} onClick={() => { void perform({ action: 'run', id: task.id }) }}>
                  {t('run')}
                </button>
                <button type="button" style={button} disabled={taskBusy} onClick={() => { void perform({ action: task.enabled ? 'pause' : 'resume', id: task.id }) }}>
                  {task.enabled ? t('pause') : t('resume')}
                </button>
                <button
                  type="button"
                  style={{ ...button, color: '#e08a8a' }}
                  disabled={taskBusy}
                  onClick={() => { if (confirm(t('removeConfirm'))) void perform({ action: 'remove', id: task.id }) }}
                >
                  {t('remove')}
                </button>
              </div>
            </div>
          )
        })}
    </div>
  )
}
