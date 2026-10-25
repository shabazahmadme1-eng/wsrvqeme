import { describe, expect, it } from 'vitest'
import { addDays, clockMs, clockToMinutes, compass, dayLabel, duration, gw, minutesToClock, signedMw } from './format'
import { axisFor, gwTick } from './ui'

describe('format', () => {
  it('formats signed megawatts with a true minus sign', () => {
    expect(signedMw(1747.9)).toBe('+1,748 MW')
    expect(signedMw(-549.3)).toBe('−549 MW')
  })

  it('formats gigawatts', () => {
    expect(gw(11609.58)).toBe('11.6 GW')
    expect(gw(1747.9, 2)).toBe('1.75 GW')
  })

  it('reads dates in UTC so the label never shifts with the viewer timezone', () => {
    expect(dayLabel('2026-01-15')).toBe('Thu 15 Jan')
    expect(dayLabel('2026-01-14T22:30:00Z')).toBe('Wed 14 Jan')
  })

  it('steps days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-01-02', -1)).toBe('2026-01-01')
  })

  it('round-trips clock times', () => {
    expect(clockToMinutes('09:30')).toBe(570)
    expect(minutesToClock(570)).toBe('09:30')
    expect(minutesToClock(clockToMinutes('23:45'))).toBe('23:45')
  })

  it('names compass points from bearings, wrapping at north', () => {
    expect(compass(0)).toBe('N')
    expect(compass(243)).toBe('WSW')
    expect(compass(272)).toBe('W')
    expect(compass(359)).toBe('N')
  })

  it('formats millisecond timestamps as UTC clock times', () => {
    expect(clockMs(Date.UTC(2026, 9, 25, 4, 0))).toBe('04:00')
  })

  it('describes durations', () => {
    expect(duration(90)).toBe('1 h 30 min')
    expect(duration(120)).toBe('2 h')
    expect(duration(30)).toBe('30 min')
  })
})

describe('axisFor', () => {
  it('rounds the top up and ticks at a round step', () => {
    const { domain, ticks } = axisFor([3000, 16500])
    expect(domain).toEqual([0, 20000])
    expect(ticks).toEqual([0, 5000, 10000, 15000, 20000])
  })

  it('keeps negative values on the axis when zero-basing is off', () => {
    const { domain, ticks } = axisFor([-1800, 5400], { zero: false })
    expect(domain[0]).toBeLessThanOrEqual(-1800)
    expect(domain[1]).toBeGreaterThanOrEqual(5400)
    expect(ticks).toContain(0)
    expect(ticks.length).toBeLessThanOrEqual(8)
  })

  it('labels ticks in GW without trailing noise', () => {
    expect(gwTick(5000)).toBe('5 GW')
    expect(gwTick(1500)).toBe('1.5 GW')
  })
})
