/**
 * 状态监控采集 —— dsh-schedule 的 host 侧子模块。
 *
 * 采集内容：
 *  - 系统资源：CPU 使用率（两次 os.cpus() 采样差值）、内存（totalmem/freemem）、
 *    磁盘（node:fs statfs，取 DSH_HOME 所在盘；平台不支持时返回 null）。
 *  - 运行时：进程运行时长、PID、Node 版本、平台、工作目录。
 *  - harness：活跃会话数、活跃/全部 agent、已安装插件数、当前模型选择。
 *
 * 采样器由 createStatusCollector 工厂创建，缓存状态收敛在闭包内
 * （可测试、插件重载不共享基线）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { cpus, freemem, totalmem } from 'node:os'
import { statfsSync } from 'node:fs'

export interface StatusSnapshot {
  readonly at: number
  readonly uptimeSeconds: number
  readonly pid: number
  readonly nodeVersion: string
  readonly platform: string
  readonly cwd: string
  readonly cpu: {
    /** 使用率百分比 0-100；首次采样无基线时为 null。 */
    readonly usagePercent: number | null
    readonly cores: number
  }
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
  readonly model: ModelSelection | null
}

interface CpuSample {
  readonly idle: number
  readonly total: number
  readonly usagePercent: number | null
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < SIZE_UNITS.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}

/** 秒 → 中文单位（命令输出无 locale 环境，统一中文）。 */
export function formatDuration(seconds: number): string {
  const parts: string[] = []
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分`)
  parts.push(`${secs} 秒`)
  return parts.join('')
}

export interface StatusCollector {
  collect(): StatusSnapshot
  render(snap: StatusSnapshot): string
}

/**
 * 创建状态采集器。CPU/磁盘为有成本操作，内部按间隔缓存。
 * agents/sessions/agentDefaultModel 缺服务时以空/未配置兜底，不抛错。
 */
export function createStatusCollector(ctx: Context, diskPath: string): StatusCollector {
  let lastCpuSample: CpuSample | undefined
  let diskCache: { at: number; stats: StatusSnapshot['disk'] } | undefined

  const collectCpuUsage = (): StatusSnapshot['cpu'] => {
    let idle = 0
    let total = 0
    let cores = 0
    try {
      for (const cpu of cpus()) {
        const t = cpu.times
        idle += t.idle
        total += t.user + t.nice + t.sys + t.idle + t.irq
        cores += 1
      }
    } catch {
      return { usagePercent: null, cores: 0 }
    }
    let usagePercent: number | null = null
    if (lastCpuSample !== undefined && lastCpuSample.total <= total) {
      const idleDelta = idle - lastCpuSample.idle
      const totalDelta = total - lastCpuSample.total
      if (totalDelta > 0) {
        usagePercent = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)))
      } else {
        // 采样间隔过短（时钟粒度内 total 相同）：复用上次值，避免一直"采样中"
        usagePercent = lastCpuSample.usagePercent
      }
    }
    lastCpuSample = { idle, total, usagePercent }
    return { usagePercent, cores }
  }

  const collectDisk = (): StatusSnapshot['disk'] => {
    const now = Date.now()
    if (diskCache !== undefined && now - diskCache.at < 5000) return diskCache.stats
    let stats: StatusSnapshot['disk']
    try {
      const info = statfsSync(diskPath)
      if (typeof info.bsize !== 'number' || info.blocks <= 0) {
        stats = { totalBytes: null, freeBytes: null, usagePercent: null }
      } else {
        const totalBytes = info.blocks * info.bsize
        const freeBytes = info.bavail * info.bsize
        stats = {
          totalBytes,
          freeBytes,
          usagePercent: totalBytes > 0 ? Math.max(0, Math.min(100, 100 * (1 - freeBytes / totalBytes))) : null,
        }
      }
    } catch {
      stats = { totalBytes: null, freeBytes: null, usagePercent: null }
    }
    diskCache = { at: now, stats }
    return stats
  }

  const collect = (): StatusSnapshot => {
    const memoryTotal = totalmem()
    const memoryFree = memoryTotal > 0 ? freemem() : 0
    const agentList = ctx.get('agents')?.list?.() ?? []
    const sessionList = ctx.get('sessions')?.list?.() ?? []
    const pluginCount = [...ctx.loader.entries()].filter((entry) => !entry.options.group).length
    const model = (ctx.get('agentDefaultModel')?.currentSelection?.()) ?? null
    return {
      at: Date.now(),
      uptimeSeconds: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      cwd: process.cwd(),
      cpu: collectCpuUsage(),
      memory: {
        totalBytes: memoryTotal,
        freeBytes: memoryFree,
        usedBytes: memoryTotal - memoryFree,
        usagePercent: memoryTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - memoryFree / memoryTotal))) : 0,
      },
      disk: collectDisk(),
      sessions: { live: sessionList.length },
      agents: {
        total: agentList.length,
        running: agentList.filter((agent) => agent.status === 'running').length,
      },
      plugins: { installed: pluginCount },
      model,
    }
  }

  const render = (snap: StatusSnapshot): string => {
    const lines: string[] = []
    const cpuLine = snap.cpu.usagePercent === null ? '采样中（稍后再试）' : `${snap.cpu.usagePercent.toFixed(1)}%`
    lines.push(`进程：${snap.pid}（${snap.platform}，Node ${snap.nodeVersion}），已运行 ${formatDuration(snap.uptimeSeconds)}`)
    lines.push(`工作目录：${snap.cwd}`)
    lines.push(`CPU：${cpuLine}（${snap.cpu.cores} 核）`)
    lines.push(`内存：${formatBytes(snap.memory.usedBytes)} / ${formatBytes(snap.memory.totalBytes)}（${snap.memory.usagePercent.toFixed(1)}%）`)
    if (snap.disk.totalBytes !== null && snap.disk.freeBytes !== null && snap.disk.usagePercent !== null) {
      lines.push(`磁盘（${diskPath}）：${formatBytes(snap.disk.freeBytes)} 可用 / ${formatBytes(snap.disk.totalBytes)}（${snap.disk.usagePercent.toFixed(1)}%）`)
    } else {
      lines.push('磁盘：当前平台不支持磁盘统计，已跳过')
    }
    lines.push(`会话：${snap.sessions.live} 个活跃`)
    lines.push(`Agent：${snap.agents.running} 运行中 / ${snap.agents.total} 总数`)
    lines.push(`插件：${snap.plugins.installed} 个已安装`)
    lines.push(`模型：${snap.model === null ? '未配置' : `${snap.model.provider}/${snap.model.model}`}`)
    return lines.join('\n')
  }

  return { collect, render }
}
