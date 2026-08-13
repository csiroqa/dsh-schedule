/**
 * 跨平台冒烟测试（本地与 CI 共用）：
 *   node --experimental-strip-types scripts/smoke.mjs
 *
 * 覆盖：host 产物可加载、cron 解析/匹配/下次运行、store 持久化与启动竞态。
 * 不依赖 DSH 运行时（纯逻辑层），三平台（Windows/macOS/Linux）均应通过。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fromRoot = (relative) => pathToFileURL(resolve(root, relative)).href

// 1) host 产物可加载
const host = await import(fromRoot('lib/index.js'))
if (typeof host.apply !== 'function' || !host.name) {
  throw new Error(`host bundle exports invalid: ${Object.keys(host).join(',')}`)
}
console.log(`host bundle ok: ${host.name}`)

// 2) cron 逻辑
const { parseCron, cronMatches, nextRun, CronParseError } = await import(fromRoot('src/cron.ts'))
if (!cronMatches(parseCron('0 9 * * *'), new Date(2026, 7, 14, 9, 0))) throw new Error('cron match failed')
if (cronMatches(parseCron('0 9 * * *'), new Date(2026, 7, 14, 9, 1))) throw new Error('cron false-positive match')
if (cronMatches(parseCron('*/15 * * * *'), new Date(2026, 7, 14, 9, 46))) throw new Error('cron step match failed')
if (nextRun(parseCron('0 0 29 2 *'), new Date(2026, 7, 14)) === null) throw new Error('leap-day next-run failed')
try {
  parseCron('61 * * * *')
  throw new Error('out-of-range cron accepted')
} catch (error) {
  if (!(error instanceof CronParseError)) throw error
}

// 3) store：持久化 + 启动竞态（不等 load 立即写，旧任务不得被覆盖）
const { ScheduleStore } = await import(fromRoot('src/store.ts'))
const logger = { warn() {} }
const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
try {
  const first = new ScheduleStore({ home, logger })
  await first.add({ cron: '0 9 * * *', prompt: 'first' })
  const racing = new ScheduleStore({ home, logger })
  await racing.add({ cron: '*/10 * * * *', prompt: 'second' })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  const reloaded = new ScheduleStore({ home, logger })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  if (reloaded.list().length !== 2) {
    throw new Error(`store race unsafed: ${reloaded.list().length} tasks persisted`)
  }
  console.log(`cron/store ok (${reloaded.list().length} tasks persisted)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
