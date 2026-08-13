/**
 * cron 解析/匹配/下次运行 单测。
 */
import { describe, expect, it } from 'vitest'
import { CronParseError, cronMatches, formatNextRun, nextRun, parseCron } from './cron'

describe('parseCron', () => {
  it('解析基本 5 字段', () => {
    const s = parseCron('0 9 * * *')
    expect(s.minutes.has(0)).toBe(true)
    expect(s.hours.has(9)).toBe(true)
    expect(s.daysOfMonth.size).toBe(31)
    expect(s.months.size).toBe(12)
    expect(s.daysOfWeek.size).toBe(7)
  })

  it('解析列表 1,5,9', () => {
    const s = parseCron('1,5,9 * * * *')
    expect([...s.minutes]).toEqual(expect.arrayContaining([1, 5, 9]))
    expect(s.minutes.size).toBe(3)
  })

  it('解析范围 1-5', () => {
    const s = parseCron('* 1-5 * * *')
    expect(s.hours.has(1)).toBe(true)
    expect(s.hours.has(5)).toBe(true)
    expect(s.hours.has(0)).toBe(false)
    expect(s.hours.has(6)).toBe(false)
  })

  it('解析步进 */15 与 1-30/5', () => {
    const star = parseCron('*/15 * * * *')
    expect(star.minutes.has(0)).toBe(true)
    expect(star.minutes.has(15)).toBe(true)
    expect(star.minutes.has(45)).toBe(true)
    expect(star.minutes.has(10)).toBe(false)
    const ranged = parseCron('1-30/5 * * * *')
    expect(ranged.minutes.has(1)).toBe(true)
    expect(ranged.minutes.has(6)).toBe(true)
    expect(ranged.minutes.has(31)).toBe(false)
  })

  it('周字段 7 规范化为 0（周日）', () => {
    const s = parseCron('* * * * 7')
    expect(s.daysOfWeek.has(0)).toBe(true)
    expect(s.daysOfWeek.has(7)).toBe(false)
  })

  it('拒绝越界值', () => {
    expect(() => parseCron('61 * * * *')).toThrow(CronParseError)
    expect(() => parseCron('* 24 * * *')).toThrow(CronParseError)
    expect(() => parseCron('* * 32 * *')).toThrow(CronParseError)
    expect(() => parseCron('* * * 13 *')).toThrow(CronParseError)
    expect(() => parseCron('* * * * 8')).toThrow(CronParseError)
  })

  it('拒绝非法输入', () => {
    expect(() => parseCron('a b c d e')).toThrow(CronParseError)
    expect(() => parseCron('* * *')).toThrow(CronParseError)
    expect(() => parseCron('5-1 * * * *')).toThrow(CronParseError)
    expect(() => parseCron('1- * * * *')).toThrow(CronParseError)
    expect(() => parseCron('*/0 * * * *')).toThrow(CronParseError)
    expect(() => parseCron('1,,5 * * * *')).toThrow(CronParseError)
    expect(() => parseCron('* * * * * *')).toThrow(CronParseError)
  })
})

describe('cronMatches', () => {
  const base = new Date(2026, 7, 14, 9, 0) // 2026-08-14 09:00

  it('精确分钟匹配', () => {
    expect(cronMatches(parseCron('0 9 * * *'), base)).toBe(true)
    expect(cronMatches(parseCron('0 9 * * *'), new Date(2026, 7, 14, 9, 1))).toBe(false)
  })

  it('步进匹配', () => {
    const s = parseCron('*/15 * * * *')
    expect(cronMatches(s, new Date(2026, 7, 14, 9, 45))).toBe(true)
    expect(cronMatches(s, new Date(2026, 7, 14, 9, 46))).toBe(false)
  })

  it('工作日限制', () => {
    const s = parseCron('0 9 * * 1-5')
    expect(cronMatches(s, new Date(2026, 7, 17, 9, 0))).toBe(true) // 周一
    expect(cronMatches(s, new Date(2026, 7, 16, 9, 0))).toBe(false) // 周日
  })

  it('dow=7 与 dow=0 等价', () => {
    const sunday = new Date(2026, 7, 16, 8, 30) // 2026-08-16 是周日
    expect(cronMatches(parseCron('30 8 * * 0'), sunday)).toBe(true)
    expect(cronMatches(parseCron('30 8 * * 7'), sunday)).toBe(true)
  })

  it('月末组合语义（2 月 31 日永不匹配）', () => {
    expect(cronMatches(parseCron('0 0 31 2 *'), new Date(2026, 1, 28, 0, 0))).toBe(false)
    expect(cronMatches(parseCron('0 0 31 2 *'), new Date(2026, 2, 1, 0, 0))).toBe(false)
  })
})

describe('nextRun', () => {
  it('返回下一个匹配分钟', () => {
    const s = parseCron('*/15 * * * *')
    const next = nextRun(s, new Date(2026, 7, 14, 9, 42))
    expect(formatNextRun(next)).toBe('2026-08-14 09:45')
  })

  it('跨天匹配', () => {
    const s = parseCron('0 9 * * *')
    const next = nextRun(s, new Date(2026, 7, 14, 14, 30))
    expect(formatNextRun(next)).toBe('2026-08-15 09:00')
  })

  it('跨年匹配闰日（扫描上限覆盖 4 年）', () => {
    const s = parseCron('0 0 29 2 *')
    const next = nextRun(s, new Date(2026, 7, 14, 9, 0))
    expect(formatNextRun(next)).toBe('2028-02-29 00:00')
  })

  it('永不匹配的表达式返回 null', () => {
    expect(nextRun(parseCron('0 0 31 2 *'), new Date(2026, 7, 14))).toBeNull()
  })

  it('null 渲染为占位符', () => {
    expect(formatNextRun(null)).toBe('—')
  })
})
