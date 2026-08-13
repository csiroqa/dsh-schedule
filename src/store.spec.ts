/**
 * 任务存储 单测：持久化、启动竞态、串行化、结果登记、损坏恢复。
 * 等待时机一律用 store.flush()（写链排空），不做时间硬编码。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleStore } from './store'

const logger = { warn: () => undefined }
const homeDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
  homeDirs.push(dir)
  return dir
}

/** 在指定目录创建存储（同目录才能验证持久化）。 */
function createStoreAt(home: string): ScheduleStore {
  return new ScheduleStore({ home, logger })
}

beforeEach(() => {
  homeDirs.length = 0
})

afterEach(() => {
  for (const dir of homeDirs) rmSync(dir, { recursive: true, force: true })
})

describe('ScheduleStore', () => {
  it('add 后持久化，新实例可读回', async () => {
    const home = tempHome()
    const store = createStoreAt(home)
    const task = await store.add({ cron: '0 9 * * *', prompt: '每日总结' })
    expect(task.id).toBeTruthy()
    expect(task.enabled).toBe(true)
    expect(task.runCount).toBe(0)

    const reloaded = createStoreAt(home)
    await reloaded.flush()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]).toMatchObject({ cron: '0 9 * * *', prompt: '每日总结' })
  })

  it('启动竞态：load 完成前立即 add 不覆盖旧任务', async () => {
    const home = tempHome()
    const first = createStoreAt(home)
    await first.add({ cron: '0 9 * * *', prompt: 'first' })

    const racing = createStoreAt(home)
    await racing.add({ cron: '*/10 * * * *', prompt: 'second' })
    await racing.flush()

    const reloaded = createStoreAt(home)
    await reloaded.flush()
    expect(reloaded.list()).toHaveLength(2)
    expect(reloaded.list().map(task => task.prompt).sort()).toEqual(['first', 'second'])
  })

  it('并发 add 串行化落盘，全部任务持久化', async () => {
    const home = tempHome()
    const store = createStoreAt(home)
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.add({ cron: `*/${index + 1} * * * *`, prompt: `task-${index}` })),
    )
    await store.flush()

    const reloaded = createStoreAt(home)
    await reloaded.flush()
    expect(reloaded.list()).toHaveLength(10)
  })

  it('remove 删除并持久化', async () => {
    const home = tempHome()
    const store = createStoreAt(home)
    const task = await store.add({ cron: '0 9 * * *', prompt: 'x' })
    expect(await store.remove(task.id)).toBe(true)
    expect(await store.remove(task.id)).toBe(false)
    expect(store.list()).toHaveLength(0)

    const reloaded = createStoreAt(home)
    await reloaded.flush()
    expect(reloaded.list()).toHaveLength(0)
  })

  it('setEnabled 切换', async () => {
    const store = createStoreAt(tempHome())
    const task = await store.add({ cron: '0 9 * * *', prompt: 'x' })
    await store.setEnabled(task.id, false)
    expect(store.get(task.id)?.enabled).toBe(false)
    expect(await store.setEnabled('missing', true)).toBeUndefined()
  })

  it('markRunning 标记运行中', async () => {
    const store = createStoreAt(tempHome())
    const task = await store.add({ cron: '0 9 * * *', prompt: 'x' })
    await store.markRunning(task.id)
    expect(store.get(task.id)?.lastStatus).toBe('running')
  })

  it('recordRun 登记成功并清理上次失败原因', async () => {
    const store = createStoreAt(tempHome())
    const task = await store.add({ cron: '0 9 * * *', prompt: 'x' })

    await store.recordRun(task.id, { status: 'error', error: 'boom', durationMs: 100, runAt: 1000 })
    let current = store.get(task.id)!
    expect(current.lastStatus).toBe('error')
    expect(current.lastError).toBe('boom')
    expect(current.runCount).toBe(1)
    expect(current.failCount).toBe(1)

    await store.recordRun(task.id, { status: 'success', durationMs: 50, runAt: 2000 })
    current = store.get(task.id)!
    expect(current.lastStatus).toBe('success')
    expect(current.lastError).toBeUndefined()
    expect(current.runCount).toBe(2)
    expect(current.failCount).toBe(1)
    expect(current.lastDurationMs).toBe(50)
  })

  it('损坏文件：空表继续且可继续写入', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'schedule.json'), '{broken json', 'utf8')
    const store = new ScheduleStore({ home, logger })
    await store.flush()
    expect(store.list()).toHaveLength(0)
    const task = await store.add({ cron: '0 9 * * *', prompt: 'recovered' })
    expect(task.prompt).toBe('recovered')
  })

  it('非法记录被清洗（字段缺失/类型错误）', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'schedule.json'), JSON.stringify([
      { id: 'ok', cron: '0 9 * * *', prompt: 'valid', enabled: true, createdAt: 1 },
      { id: 'no-prompt', cron: '0 9 * * *' },
      { id: 'string-enabled', cron: '0 9 * * *', prompt: 'x', enabled: 'false' },
      42,
      'junk',
    ]), 'utf8')
    const store = new ScheduleStore({ home, logger })
    await store.flush()
    const tasks = store.list()
    expect(tasks).toHaveLength(2)
    expect(tasks.some(task => task.id === 'ok')).toBe(true)
    expect(tasks.some(task => task.id === 'string-enabled' && task.enabled === false)).toBe(true)
    expect(tasks.every(task => typeof task.id === 'string' && typeof task.prompt === 'string')).toBe(true)
  })

  it('list 排序按创建时间', async () => {
    const store = createStoreAt(tempHome())
    const first = await store.add({ cron: '* * * * *', prompt: 'a' })
    const second = await store.add({ cron: '* * * * *', prompt: 'b' })
    expect(store.list()[0]!.id).toBe(first.id)
    expect(store.list()[1]!.id).toBe(second.id)
    expect(store.list()[1]!.prompt).toBe('b')
  })
})
