// Numbers are shown in GW when quoting a headline, in MW (with thousands separators) when precision matters.

const int = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const one = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })

export const mw = (v: number) => `${int.format(Math.round(v))} MW`
export const gw = (v: number, digits = 1) => `${(v / 1000).toFixed(digits)} GW`
export const signedMw = (v: number) => `${v >= 0 ? '+' : '−'}${int.format(Math.abs(Math.round(v)))} MW`
export const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`
export const signedPct = (v: number) => `${v >= 0 ? '+' : '−'}${one.format(Math.abs(v))}%`
export const count = (v: number) => int.format(v)

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** "Thu 15 Jan" from an ISO date or timestamp (always read in UTC; January UTC == UK time). */
export const dayLabel = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return `${WEEKDAY.format(d)} ${DAY.format(d)}`
}

export const clock = (iso: string) => iso.slice(11, 16)

/** "04:00" for a millisecond timestamp, in UTC. */
export const clockMs = (ms: number) => new Date(ms).toISOString().slice(11, 16)

/** 16-point compass name for a bearing in degrees. */
export const compass = (deg: number) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16]

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const minutesToClock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export const clockToMinutes = (c: string) => {
  const [h, m] = c.split(':').map(Number)
  return h * 60 + m
}

/** "1 h 30 min" */
export const duration = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}
