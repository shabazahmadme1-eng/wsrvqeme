import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, ApiError, type DecisionResponse, type Meta } from './api'
import { addDays, clock, clockToMinutes, count, dayLabel, gw, minutesToClock, mw, signedMw } from './format'
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

/** Average lower and upper edge of the likely range, or null before there is a track record to build one. */
const bandMeans = (d: DecisionResponse) =>
  d.band ? { low: mean(d.points.map((p) => p.low_mw ?? 0)), high: mean(d.points.map((p) => p.high_mw ?? 0)) } : null

const addHour = (iso: string) => new Date(new Date(iso).getTime() + 3600_000).toISOString()

const ForecastTooltip = makeTooltip((d) => {
  const p = d.point as DecisionResponse['points'][number]
  const items: [string, string][] = [['Forecast', mw(p.forecast_mw)]]
  if (p.low_mw !== null && p.high_mw !== null) items.push(['Likely range', `${mw(p.low_mw)} to ${mw(p.high_mw)}`])
  items.push(['Released', `${clock(p.published)} (${p.horizon_h.toFixed(1)} h ahead)`])
  if (p.revision_mw !== null) items.push(['Change vs previous release', signedMw(p.revision_mw)])
  if (d.showActual && p.actual_mw !== null) {
    items.push(['Actual (hindcast)', mw(p.actual_mw)], ['Forecast error', signedMw(p.forecast_mw - p.actual_mw)])
  }
  return { title: `${clock(p.target)}–${clock(addHour(p.target))}`, items }
})

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
        ) : publications.error ? (
          // The timeline is the only cutoff control on this page, so keep a plain one when it can't load.
          <div className="stack">
            <Notice error title="Couldn't load the release timeline">
              {publications.error.message}. You can still set the cutoff here.
            </Notice>
            <div className="field">
              <label htmlFor="cutoff-fallback">Decide by (previous day, UTC)</label>
              <input id="cutoff-fallback" type="time" step={900} value={minutesToClock(cutoff)} onChange={(e) => e.target.value && onCutoff(clockToMinutes(e.target.value))} />
            </div>
          </div>
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
            {d.missing_hours.length > 0 && (
              <Notice title={`Only ${d.summary.hours} of 24 hours had a forecast by ${d.cutoff_utc}`}>
                No release published by then reached {d.missing_hours.map((h) => clock(h)).join(' and ')} on {dayLabel(d.delivery_date)}. The figures here cover the hours
                that did; move the handle past the first release of {dayLabel(d.decision_time)} to see the whole day.
              </Notice>
            )}
            <RangeStats d={d} />
          </div>
          <Panel
            title="Expected wind generation, hour by hour"
            sub={
              d.band
                ? `National wind, average output in each hour. Shaded band: this forecast shifted by the 10th to 90th percentile misses of the ${d.band.history_days} delivery days already finished at the decision time.`
                : 'National wind, average output in each hour. No likely range yet: fewer than three delivery days had finished at the decision time.'
            }
          >
            <div className="chart" role="img" aria-label={`Hourly wind forecast for ${dayLabel(d.delivery_date)}, averaging ${gw(d.summary.mean_mw)}`}>
              <ForecastChart d={d} showActual={showActual} />
            </div>
            <Legend
              items={[
                { label: 'Forecast', color: COLORS.forecast },
                ...(d.band ? [{ label: 'Likely range (80%)', color: COLORS.forecast, band: true }] : []),
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
  const band = d.band
  return (
    <div>
      <p className="briefing">
        For <b>{dayLabel(d.delivery_date)}</b>, the forecast released at <strong>{clock(latest)}</strong> on {dayLabel(latest)} expects wind to average{' '}
        <strong>{gw(d.summary.mean_mw)}</strong>, peaking at <strong>{gw(d.summary.peak_mw)}</strong> around {clock(d.summary.peak_hour)} and dipping to{' '}
        <strong>{gw(d.summary.trough_mw)}</strong> around {clock(d.summary.trough_hour)}.
      </p>
      {band ? (
        <p className="briefing">
          Over the {band.history_days} delivery days already finished by this decision ({dayLabel(band.history_from)} to {dayLabel(band.history_to)}), forecasts made by this cutoff
          ran <strong className="warn">{gw(Math.abs(band.bias_mw), 2)}</strong> {band.bias_mw >= 0 ? 'above' : 'below'} what wind delivered. The likely range below allows for misses
          like theirs.
        </p>
      ) : (
        <p className="briefing">
          Fewer than three delivery days had finished by this decision, so there is no track record yet to size a likely range. It appears once there is.
        </p>
      )}
    </div>
  )
}

function RangeStats({ d }: { d: DecisionResponse }) {
  const edges = bandMeans(d)
  const energy = `${count(Math.round(d.summary.energy_mwh / 1000))} GWh`
  return (
    <dl className="grid stats" aria-label="Expected average output">
      <Stat
        label="Expected average"
        value={gw(d.summary.mean_mw)}
        hint={d.summary.hours === 24 ? `${energy} over the day` : `${energy} over the ${d.summary.hours} hours with a forecast`}
      />
      {edges && d.band ? (
        <>
          <Stat label="Lower edge of range" value={gw(edges.low)} hint={`if this forecast misses like the last ${d.band.history_days} days did, output falls below this about 1 hour in 10`} />
          <Stat label="Upper edge of range" value={gw(edges.high)} hint="and rises above this about 1 hour in 10" />
        </>
      ) : (
        <Stat label="Likely range" value="–" hint="needs three finished delivery days" />
      )}
    </dl>
  )
}

function ForecastChart({ d, showActual }: { d: DecisionResponse; showActual: boolean }) {
  const axis = axisFor(d.points.flatMap((p) => [p.high_mw ?? p.forecast_mw, p.actual_mw ?? 0]))
  const rows = d.points.map((p) => ({
    hour: clock(p.target),
    forecast: p.forecast_mw,
    band: p.low_mw !== null && p.high_mw !== null ? [p.low_mw, p.high_mw] : null,
    actual: showActual ? p.actual_mw : null,
    point: p,
    showActual,
  }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="hour" interval={2} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
        <YAxis domain={axis.domain} ticks={axis.ticks} width={64} tickFormatter={gwTick} tick={{ fill: COLORS.muted, fontSize: 12 }} tickLine={false} axisLine={false} />
        <Tooltip content={ForecastTooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
        {d.band && <Area dataKey="band" stroke={COLORS.forecast} strokeOpacity={0.35} fill={COLORS.forecast} fillOpacity={0.16} isAnimationActive={false} activeDot={false} />}
        <Line dataKey="forecast" stroke={COLORS.forecast} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        {showActual && <Line dataKey="actual" stroke={COLORS.ink} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function HourTable({ d, showActual }: { d: DecisionResponse; showActual: boolean }) {
  const dash = (v: number | null) => (v === null ? '–' : mw(v))
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
                <td>{dash(p.low_mw)}</td>
                <td>{dash(p.high_mw)}</td>
                <td>{clock(p.published)}</td>
                {showActual && <td>{dash(p.actual_mw)}</td>}
                {showActual && <td>{p.actual_mw === null ? '–' : signedMw(p.forecast_mw - p.actual_mw)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
