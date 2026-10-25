import { useEffect, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type LiveResponse } from './api'
import { clock, clockMs, compass, dayLabel, gw, mw, signedMw } from './format'
import { COLORS, Legend, Notice, Panel, Skeleton, Stat, axisFor, gwTick, makeTooltip } from './ui'
import { useRemote } from './useApi'

const REFRESH_MS = 5 * 60 * 1000
const SHUTDOWN_MS = 25 // many large turbines begin shutting down around this 100 m wind speed (approximate)

const atMs = (iso: string) => new Date(iso).getTime()
const isoOf = (ms: number) => new Date(ms).toISOString()

/** Six-hourly UTC tick positions covering [from, to]. */
function timeTicks(from: number, to: number) {
  const step = 6 * 3600_000
  const ticks: number[] = []
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t)
  return ticks
}

const tickLabel = (ms: number) => (clockMs(ms) === '00:00' ? dayLabel(isoOf(ms)) : clockMs(ms))
const axisTick = { fill: COLORS.muted, fontSize: 12 }

export function LiveView() {
  const [refresh, setRefresh] = useState(0)
  const live = useRemote((s) => api.live(s), [refresh])

  useEffect(() => {
    const id = setInterval(() => !document.hidden && setRefresh((n) => n + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const d = live.data
  return (
    <div className="stack">
      <div className="controls">
        <button className="btn" style={{ padding: '0 16px' }} onClick={() => setRefresh((n) => n + 1)} disabled={live.loading}>
          {live.loading ? 'Refreshing…' : 'Refresh now'}
        </button>
        {d && (
          <p className="sub" style={{ margin: 0 }}>
            As of <span className="mono">{clock(d.as_of)} UTC</span>
            {d.forecast_published && (
              <>
                {' '}
                · forecast released <span className="mono">{clock(d.forecast_published)}</span>
              </>
            )}
            {d.weather?.observed_at && (
              <>
                {' '}
                · weather observed <span className="mono">{clock(d.weather.observed_at)}</span>
              </>
            )}
            . Updates every 5 minutes.
          </p>
        )}
      </div>

      {live.error && !d && (
        <Notice error title="Couldn't load live data">
          {live.error.message}
        </Notice>
      )}
      {d?.errors.elexon && (
        <Notice error title="Live Elexon data is unavailable">
          Elexon: {d.errors.elexon}. The January analysis on the other pages is unaffected.
        </Notice>
      )}
      {d?.errors.weather && (
        <Notice error title="Live weather is unavailable">
          Open-Meteo: {d.errors.weather}. Forecast and output are still shown below.
        </Notice>
      )}

      {d ? (
        <div className={`stack${live.loading ? ' refreshing' : ''}`}>
          <Briefing d={d} />
          <NowStrip d={d} />
          {d.forecast.length > 0 && <OutputChart d={d} />}
          {d.weather && <WeatherPanel d={d} />}
          <Panel title="Read this first">
            <div className="prose">
              <ul>
                <li>This tab is a live extra. It is outside the January 2026 analysis, and nothing here feeds the accuracy figures.</li>
                <li>The likely-range band comes from January's forecast errors. Today's weather can be very different, so treat it as indicative.</li>
                <li>
                  The weather index is the plain average of 100 m wind speed at six wind-farm areas. It says whether it is windy where the turbines are. It is not a model of output.
                </li>
                <li>Times are UTC. UK clocks are an hour ahead of UTC in summer.</li>
                <li>
                  Weather data by <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0).
                </li>
              </ul>
            </div>
          </Panel>
        </div>
      ) : (
        !live.error && <Skeleton height={520} />
      )}
    </div>
  )
}

function Briefing({ d }: { d: LiveResponse }) {
  const latest = d.actuals.at(-1)
  const now = atMs(d.as_of)
  const next24 = d.forecast.filter((p) => atMs(p.target) < now + 24 * 3600_000)
  const avg24 = next24.length ? next24.reduce((s, p) => s + p.forecast_mw, 0) / next24.length : null
  const idx = d.weather?.index.filter((p) => atMs(p.time) >= now - 3600_000) ?? []
  const windiest = idx.length ? idx.reduce((a, b) => (b.wind_speed_100m_ms > a.wind_speed_100m_ms ? b : a)) : null
  const calmest = idx.length ? idx.reduce((a, b) => (b.wind_speed_100m_ms < a.wind_speed_100m_ms ? b : a)) : null
  const siteSpeeds = d.weather?.sites.map((s) => s.wind_speed_100m_ms).filter((v): v is number => v !== null) ?? []
  const meanNow = siteSpeeds.length ? siteSpeeds.reduce((a, b) => a + b, 0) / siteSpeeds.length : null

  return (
    <div>
      <p className="briefing">
        {latest && (
          <>
            Wind is producing <strong>{gw(latest.generation_mw)}</strong> in the half-hour from {clock(latest.start)}.{' '}
          </>
        )}
        {avg24 !== null && d.forecast_published ? (
          <>
            The forecast released at <strong>{clock(d.forecast_published)}</strong> expects an average of <strong>{gw(avg24)}</strong> over the next 24 hours.
          </>
        ) : (
          <>No live forecast is available right now.</>
        )}
      </p>
      {meanNow !== null && windiest && calmest && (
        <p className="briefing">
          Weather models put wind at 100 m across six wind-farm areas at <strong>{meanNow.toFixed(1)} m/s</strong> now. Over the next two days the strongest hour is{' '}
          <strong>{windiest.wind_speed_100m_ms.toFixed(1)} m/s</strong> ({dayLabel(windiest.time)} {clock(windiest.time)}) and the lightest is{' '}
          <strong>{calmest.wind_speed_100m_ms.toFixed(1)} m/s</strong> ({dayLabel(calmest.time)} {clock(calmest.time)}).
        </p>
      )}
    </div>
  )
}

function NowStrip({ d }: { d: LiveResponse }) {
  const latest = d.actuals.at(-1)
  if (!latest) return null
  const hour = isoOf(Math.floor(atMs(latest.start) / 3600_000) * 3600_000)
  const f = d.forecast.find((p) => isoOf(atMs(p.target)) === hour)
  return (
    <dl className="grid stats" style={{ margin: 0 }}>
      <Stat label="Wind output, latest half-hour" value={mw(latest.generation_mw)} hint={`from ${clock(latest.start)} UTC, metered`} />
      <Stat label="Forecast for that hour" value={f ? mw(f.forecast_mw) : '–'} hint={f && d.forecast_published ? `latest release, ${clock(d.forecast_published)}` : 'no forecast for that hour'} />
      {f && (
        <Stat
          label="Forecast minus output"
          value={signedMw(f.forecast_mw - latest.generation_mw)}
          hint={f.forecast_mw > latest.generation_mw ? 'forecast above what is being produced' : 'forecast below what is being produced'}
          warn={f.forecast_mw > latest.generation_mw}
        />
      )}
    </dl>
  )
}

const outputTooltip = makeTooltip((r) => {
  const items: [string, string][] = []
  if (typeof r.forecast === 'number') items.push(['Forecast', mw(r.forecast)])
  if (Array.isArray(r.band)) items.push(['Likely range', `${mw(r.band[0])} to ${mw(r.band[1])}`])
  if (typeof r.actual === 'number') items.push(['Actual output', mw(r.actual)])
  const iso = isoOf(r.t as number)
  return { title: `${dayLabel(iso)} ${clock(iso)} UTC`, items }
})

interface OutputRow {
  t: number
  forecast?: number
  band?: number[]
  actual?: number
}

function OutputChart({ d }: { d: LiveResponse }) {
  const rows = new Map<number, OutputRow>()
  const row = (t: number): OutputRow => {
    let r = rows.get(t)
    if (!r) rows.set(t, (r = { t }))
    return r
  }
  for (const p of d.forecast) {
    const r = row(atMs(p.target))
    r.forecast = p.forecast_mw
    if (p.low_mw !== null && p.high_mw !== null) r.band = [p.low_mw, p.high_mw]
  }
  for (const a of d.actuals) row(atMs(a.start)).actual = a.generation_mw
  const data = [...rows.values()].sort((a, b) => a.t - b.t)
  const axis = axisFor(data.flatMap((r) => [r.actual ?? 0, r.forecast ?? 0, ...(r.band ?? [])]))
  const now = atMs(d.as_of)
  const from = data[0].t
  const to = data[data.length - 1].t

  return (
    <Panel title="National wind output: what happened, and what is expected" sub="Metered half-hourly output up to now, then the latest forecast for the next two days.">
      <div className="chart" role="img" aria-label="Recent wind output and the latest forecast">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} ticks={timeTicks(from, to)} tickFormatter={tickLabel} tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis domain={axis.domain} ticks={axis.ticks} tickFormatter={gwTick} width={64} tick={axisTick} tickLine={false} axisLine={false} />
            <Tooltip content={outputTooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
            <ReferenceLine x={now} stroke={COLORS.ink} strokeDasharray="4 3" label={{ value: 'Now', position: 'insideTopRight', fill: COLORS.ink, fontSize: 12 }} />
            <Area dataKey="band" stroke={COLORS.forecast} strokeOpacity={0.35} fill={COLORS.forecast} fillOpacity={0.14} isAnimationActive={false} activeDot={false} connectNulls />
            <Line dataKey="forecast" stroke={COLORS.forecast} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="actual" stroke={COLORS.ink} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend
        items={[
          { label: 'Actual output', color: COLORS.ink },
          { label: 'Latest forecast', color: COLORS.forecast },
          { label: 'Likely range (from January errors)', color: COLORS.forecast, band: true },
        ]}
      />
    </Panel>
  )
}

const weatherTooltip = makeTooltip((r) => {
  const iso = isoOf(r.t as number)
  return { title: `${dayLabel(iso)} ${clock(iso)} UTC`, items: [['Mean wind at 100 m', `${(r.speed as number).toFixed(1)} m/s`]] }
})

function WeatherPanel({ d }: { d: LiveResponse }) {
  const w = d.weather!
  const data = w.index.map((p) => ({ t: atMs(p.time), speed: p.wind_speed_100m_ms }))
  if (!data.length) return null
  const top = Math.max(SHUTDOWN_MS + 5, Math.ceil(Math.max(...data.map((r) => r.speed)) / 5) * 5)
  const ticks = Array.from({ length: top / 5 + 1 }, (_, i) => i * 5)
  const now = atMs(d.as_of)
  const from = data[0].t
  const to = data[data.length - 1].t
  return (
    <Panel title="The weather behind it" sub="Average wind speed at turbine height (100 m) across six wind-farm areas, for the past day and a half and the next two days.">
      <div className="chart short" role="img" aria-label="Mean 100 metre wind speed across six wind-farm areas">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} ticks={timeTicks(from, to)} tickFormatter={tickLabel} tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis domain={[0, top]} ticks={ticks} tickFormatter={(v: number) => `${v} m/s`} width={64} tick={axisTick} tickLine={false} axisLine={false} />
            <Tooltip content={weatherTooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
            <ReferenceLine y={SHUTDOWN_MS} stroke={COLORS.bias} strokeDasharray="6 4" />
            <ReferenceLine x={now} stroke={COLORS.ink} strokeDasharray="4 3" />
            <Line dataKey="speed" stroke={COLORS.forecast} strokeWidth={2.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Legend
        items={[
          { label: 'Mean wind speed at 100 m', color: COLORS.forecast },
          { label: `About ${SHUTDOWN_MS} m/s: many large turbines begin shutting down`, color: COLORS.bias, dashed: true },
        ]}
      />
      <details open>
        <summary>Wind at each area right now</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Area</th>
                <th>Wind at 100 m</th>
                <th>Gusts at 10 m</th>
                <th>Blowing from</th>
              </tr>
            </thead>
            <tbody>
              {w.sites.map((s) => (
                <tr key={s.name}>
                  <td style={{ fontFamily: 'var(--font-body)' }}>{s.name}</td>
                  <td>{s.wind_speed_100m_ms === null ? '–' : `${s.wind_speed_100m_ms.toFixed(1)} m/s`}</td>
                  <td>{s.gust_10m_ms === null ? '–' : `${s.gust_10m_ms.toFixed(1)} m/s`}</td>
                  <td>{s.direction_deg === null ? '–' : `${compass(s.direction_deg)} (${s.direction_deg}°)`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  )
}
