import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, ApiError, type DecisionResponse, type Meta } from './api'
import { addDays, clock, count, dayLabel, gw, minutesToClock, mw, signedMw } from './format'
import { PublicationLadder } from './PublicationLadder'
import { axisFor, COLORS, gwTick, makeTooltip } from './chart'
import { Legend, Notice, Panel, Skeleton, Stat } from './ui'
import { useDebounced, useRemote } from './useApi'

interface Props {
  meta: Meta
  cutoff: number
  onCutoff: (minutes: number) => void
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const bandMeans = (d: DecisionResponse) => ({ low: mean(d.points.map((p) => p.low_mw)), high: mean(d.points.map((p) => p.high_mw)) })

const ForecastTooltip = makeTooltip((d) => {
  const p = d.point as DecisionResponse['points'][number]
  const items: [string, string][] = [
    ['Forecast', mw(p.forecast_mw)],
    ['Likely range', `${mw(p.low_mw)} to ${mw(p.high_mw)}`],
    ['Released', `${clock(p.published)} (${p.horizon_h.toFixed(1)} h ahead)`],
  ]
  if (p.revision_mw !== null) items.push(['Change vs previous release', signedMw(p.revision_mw)])
  if (d.showActual && p.actual_mw !== null) {
    items.push(['Actual (hindcast)', mw(p.actual_mw)], ['Forecast error', signedMw(p.forecast_mw - p.actual_mw)])
  }
  return { title: `${clock(p.target)}–${clock(addHour(p.target))}`, items }
})

const addHour = (iso: string) => new Date(new Date(iso).getTime() + 3600_000).toISOString()

const ForecastAxis = (d: DecisionResponse) =>
  axisFor(d.points.flatMap((p) => [p.high_mw, p.actual_mw ?? 0]))

export function DecisionView({ meta, cutoff, onCutoff }: Props) {
  const { delivery_from: first, delivery_to: last } = meta.coverage
  const [deliveryDate, setDeliveryDate] = useState('2026-01-15')
  const [showActual, setShowActual] = useState(true)

  const cutoffClock = minutesToClock(useDebounced(cutoff, 200))
  const publications = useRemote((s) => api.publications(deliveryDate, s), [deliveryDate])
  const decision = useRemote((s) => api.decision(deliveryDate, cutoffClock, s), [deliveryDate, cutoffClock])
  const d = decision.data

  return (
    <div className="stack">
      <div className="controls">
        <div className="field">
          <span className="label" id="delivery-label">
            Delivery day
          </span>
          <div className="stepper" role="group" aria-labelledby="delivery-label">
            <button className="btn" onClick={() => setDeliveryDate(addDays(deliveryDate, -1))} disabled={deliveryDate <= first} aria-label="Previous day">
              ‹
            </button>
            <input
              type="date"
              value={deliveryDate}
              min={first}
              max={last}
              aria-label="Delivery day"
              onChange={(e) => e.target.value >= first && e.target.value <= last && setDeliveryDate(e.target.value)}
            />
            <button className="btn" onClick={() => setDeliveryDate(addDays(deliveryDate, 1))} disabled={deliveryDate >= last} aria-label="Next day">
              ›
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={showActual} onChange={(e) => setShowActual(e.target.checked)} />
          Show what wind actually did (only known afterwards)
        </label>
      </div>

      <Panel
        title="When do you have to decide?"
        sub="Forecasts are re-issued through the day. Drag the handle to the moment the day-ahead purchase has to be placed: the forecast below is the latest release before it."
      >
        {publications.data ? (
          <PublicationLadder
            decisionDay={publications.data.decision_day}
            publications={publications.data.publications}
            previousRelease={publications.data.previous_release}
            cutoff={cutoff}
            onChange={onCutoff}
          />
        ) : (
          <Skeleton height={112} />
        )}
      </Panel>

      {decision.error && !(decision.error instanceof ApiError && decision.error.status === 404) && (
        <Notice error title="Couldn't load this forecast">
          {decision.error.message}
        </Notice>
      )}

      {decision.error instanceof ApiError && decision.error.status === 404 && (
        <Notice title="No forecast had been released by then">
          Nothing was published before {cutoffClock} on {dayLabel(addDays(deliveryDate, -1))}. Move the handle later to see the first release of the day.
        </Notice>
      )}

      {d ? (
        <div className={`stack${decision.loading ? ' refreshing' : ''}`}>
          <div className="hero">
            <Briefing d={d} />
            <RangeStats d={d} />
          </div>
          <Panel title="Expected wind generation, hour by hour" sub="National wind, average output in each hour of the delivery day. Shaded band: where outcomes landed in 8 of 10 January hours, applied to this forecast.">
            <div className="chart" role="img" aria-label={`Hourly wind forecast for ${dayLabel(d.delivery_date)}, averaging ${gw(d.summary.mean_mw)}`}>
              <ForecastChart d={d} showActual={showActual} />
            </div>
            <Legend
              items={[
                { label: 'Forecast', color: COLORS.forecast },
                { label: 'Likely range (80%)', color: COLORS.forecast, band: true },
                ...(showActual ? [{ label: 'Actual (hindcast)', color: COLORS.ink, dashed: true }] : []),
              ]}
            />
            {showActual && d.day_accuracy && (
              <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
                How this day turned out: wind averaged <span className="mono">{gw(d.day_accuracy.mean_actual_mw)}</span> against a forecast of{' '}
                <span className="mono">{gw(d.day_accuracy.mean_forecast_mw)}</span>. The forecast was off by <span className="mono">{mw(d.day_accuracy.mae_mw)}</span> per hour on average
                ({signedMw(d.day_accuracy.bias_mw)} bias).
              </p>
            )}
            <HourTable d={d} showActual={showActual} />
          </Panel>
        </div>
      ) : (
        !decision.error && <Skeleton height={420} />
      )}
    </div>
  )
}

function Briefing({ d }: { d: DecisionResponse }) {
  const latest = d.points.reduce((a, p) => (p.published > a ? p.published : a), d.points[0].published)
  const lowMean = bandMeans(d).low
  const oneSided = Math.round(((1 + d.band.level) / 2) * 10)
  const high = d.historical_bias_mw >= 0
  return (
    <div>
      <p className="briefing">
        For <b>{dayLabel(d.delivery_date)}</b>, the forecast released at <strong>{clock(latest)}</strong> on {dayLabel(latest)} expects wind to average{' '}
        <strong>{gw(d.summary.mean_mw)}</strong>, peaking at <strong>{gw(d.summary.peak_mw)}</strong> around {clock(d.summary.peak_hour)} and dipping to{' '}
        <strong>{gw(d.summary.trough_mw)}</strong> around {clock(d.summary.trough_hour)}.
      </p>
      <p className="briefing">
        Across January, forecasts made by this cutoff ran <strong className="warn">{gw(Math.abs(d.historical_bias_mw), 2)}</strong> {high ? 'above' : 'below'} what wind delivered. Had you
        planned on the lower edge of the band (<strong>{gw(lowMean)}</strong> on average), output would have stayed above it in about {oneSided} of 10 hours.
      </p>
    </div>
  )
}

function RangeStats({ d }: { d: DecisionResponse }) {
  const { low, high } = bandMeans(d)
  const tail = Math.round(((1 - d.band.level) / 2) * 10)
  return (
    <dl className="grid stats" aria-label="Expected average output">
      <Stat label="Expected average" value={gw(d.summary.mean_mw)} hint={`${count(Math.round(d.summary.energy_mwh / 1000))} GWh over the day`} />
      <Stat label="Lower edge of range" value={gw(low)} hint={`average output fell below this about ${tail} hour in 10 in January`} />
      <Stat label="Upper edge of range" value={gw(high)} hint={`and rose above this about ${tail} hour in 10`} />
    </dl>
  )
}

function ForecastChart({ d, showActual }: { d: DecisionResponse; showActual: boolean }) {
  const axis = ForecastAxis(d)
  const rows = d.points.map((p) => ({
    hour: clock(p.target),
    forecast: p.forecast_mw,
    band: [p.low_mw, p.high_mw],
    actual: showActual ? p.actual_mw : null,
    point: p,
    showActual,
  }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="hour" interval={2} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
        <YAxis
          domain={axis.domain}
          ticks={axis.ticks}
          width={64}
          tickFormatter={gwTick}
          tick={{ fill: COLORS.muted, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={ForecastTooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
        <Area dataKey="band" stroke={COLORS.forecast} strokeOpacity={0.35} fill={COLORS.forecast} fillOpacity={0.16} isAnimationActive={false} activeDot={false} />
        <Line dataKey="forecast" stroke={COLORS.forecast} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        {showActual && <Line dataKey="actual" stroke={COLORS.ink} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function HourTable({ d, showActual }: { d: DecisionResponse; showActual: boolean }) {
  return (
    <details>
      <summary>Show the numbers</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hour</th>
              <th>Forecast</th>
              <th>Range low</th>
              <th>Range high</th>
              <th>Released</th>
              {showActual && <th>Actual</th>}
              {showActual && <th>Error</th>}
            </tr>
          </thead>
          <tbody>
            {d.points.map((p) => (
              <tr key={p.target}>
                <td>{clock(p.target)}</td>
                <td>{mw(p.forecast_mw)}</td>
                <td>{mw(p.low_mw)}</td>
                <td>{mw(p.high_mw)}</td>
                <td>{clock(p.published)}</td>
                {showActual && <td>{p.actual_mw === null ? '–' : mw(p.actual_mw)}</td>}
                {showActual && <td>{p.actual_mw === null ? '–' : signedMw(p.forecast_mw - p.actual_mw)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
