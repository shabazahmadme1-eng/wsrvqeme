import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, ApiError, type AccuracyResponse, type GroupMetrics, type HorizonResponse } from './api'
import { clockToMinutes, count, dayLabel, gw, minutesToClock, mw, pct, signedMw, signedPct } from './format'
import { COLORS, Legend, Notice, Panel, Skeleton, Stat, axisFor, gwTick, makeTooltip } from './ui'
import { useDebounced, useRemote } from './useApi'

interface Props {
  cutoff: number
  onCutoff: (minutes: number) => void
}

const axisTick = { fill: COLORS.muted, fontSize: 12 }
const shortDay = (iso: string) => dayLabel(iso).slice(4)

export function AccuracyView({ cutoff, onCutoff }: Props) {
  const cutoffClock = minutesToClock(useDebounced(cutoff, 250))
  const accuracy = useRemote((s) => api.accuracy(cutoffClock, s), [cutoffClock])
  const horizon = useRemote((s) => api.horizon(6, s), [])
  const a = accuracy.data

  return (
    <div className="stack">
      <div className="controls">
        <div className="field">
          <label htmlFor="cutoff-input">Purchase decided by (previous day)</label>
          <input
            id="cutoff-input"
            type="time"
            step={900}
            value={minutesToClock(cutoff)}
            onChange={(e) => e.target.value && onCutoff(clockToMinutes(e.target.value))}
          />
        </div>
      </div>

      {accuracy.error && (
        <Notice error={!(accuracy.error instanceof ApiError && accuracy.error.status === 404)} title="No accuracy figures for this cutoff">
          {accuracy.error.message}
        </Notice>
      )}

      {a ? (
        <div className={`stack${accuracy.loading ? ' refreshing' : ''}`}>
          <Headline a={a} />
          <Stats a={a} />
          <div className="grid two">
            <ByDay rows={a.by_delivery_day} />
            <ByHour rows={a.by_hour_of_day} />
          </div>
          <div className="grid two">
            <Histogram a={a} />
            <Horizon horizon={horizon.data} failed={horizon.error?.message} />
          </div>
          <div className="grid two">
            <BiasCorrectionCard a={a} />
            <ReliabilityCard a={a} />
          </div>
        </div>
      ) : (
        !accuracy.error && <Skeleton height={520} />
      )}
    </div>
  )
}

function Headline({ a }: { a: AccuracyResponse }) {
  const o = a.overall
  const high = o.bias_mw >= 0
  const total = a.error_histogram.reduce((s, b) => s + b.count, 0)
  const tooHigh = a.error_histogram.filter((b) => b.from_mw >= 0).reduce((s, b) => s + b.count, 0)
  return (
    <div>
      <p className="briefing">
        Across every January decision, the forecast available at <strong>{a.cutoff_utc}</strong> missed by <strong>{mw(o.mae_mw)}</strong> an hour on average, which is{' '}
        <strong>{pct(o.mae_pct, 0)}</strong> of the wind actually generated.
      </p>
      <p className="briefing">
        The misses were not random: the forecast ran <strong className="warn">{mw(Math.abs(o.bias_mw))}</strong> {high ? 'too high' : 'too low'} on average ({signedPct(o.bias_pct)}), and was
        too high in <strong className="warn">{pct((100 * tooHigh) / total, 0)}</strong> of hours. Taken at face value, it overstates the wind a buyer can count on.
      </p>
    </div>
  )
}

function Stats({ a }: { a: AccuracyResponse }) {
  const o = a.overall
  return (
    <dl className="grid stats" style={{ margin: 0 }}>
      <Stat label="Average miss (MAE)" value={mw(o.mae_mw)} hint={`${pct(o.mae_pct)} of average output`} />
      <Stat label="Bias" value={signedMw(o.bias_mw)} hint={o.bias_mw >= 0 ? 'forecast above actual' : 'forecast below actual'} warn />
      <Stat label="Big misses (P90)" value={mw(o.p90_abs_error_mw)} hint="1 hour in 10 was off by more" />
      <Stat label="RMSE" value={mw(o.rmse_mw)} hint="penalises large misses more" />
      <Stat label="Beats a naive guess by" value={pct(a.baseline.skill_vs_baseline_pct, 0)} hint={`vs “${a.baseline.name.toLowerCase()}”: ${mw(a.baseline.metrics.mae_mw)} MAE`} />
      <Stat label="Hours scored" value={count(o.n)} hint={`${a.by_delivery_day.length} delivery days`} />
    </dl>
  )
}

const dayTooltip = makeTooltip((d) => {
  const g = d.g as GroupMetrics
  return {
    title: dayLabel(g.key),
    items: [
      ['Average miss (MAE)', mw(g.mae_mw)],
      ['Bias', signedMw(g.bias_mw)],
      ['Actual wind, average', mw(g.mean_actual_mw)],
    ],
  }
})

function ByDay({ rows }: { rows: GroupMetrics[] }) {
  const data = rows.map((g) => ({ key: g.key, mae: g.mae_mw, bias: g.bias_mw, g }))
  const AXIS = axisFor(data.flatMap((r) => [r.mae, r.bias]), { zero: false })
  return (
    <Panel title="Each delivery day" sub="Bars show bias (amber = forecast too high); the line is the average miss. Good days and bad days look very different.">
      <div className="chart short" role="img" aria-label="Daily forecast bias and average miss for each January delivery day">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="key" tickFormatter={shortDay} interval={4} tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={gwTick} width={64} tick={axisTick} tickLine={false} axisLine={false} domain={AXIS.domain} ticks={AXIS.ticks} />
            <Tooltip content={dayTooltip} cursor={{ fill: 'rgba(15,43,54,0.06)' }} />
            <Bar dataKey="bias" isAnimationActive={false}>
              {data.map((r) => (
                <Cell key={r.key} fill={r.bias >= 0 ? COLORS.bias : COLORS.forecast} />
              ))}
            </Bar>
            <Line dataKey="mae" stroke={COLORS.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ label: 'Bias', color: COLORS.bias }, { label: 'Average miss (MAE)', color: COLORS.ink }]} />
    </Panel>
  )
}

const hourTooltip = makeTooltip((d) => {
  const g = d.g as GroupMetrics
  return {
    title: `Hour starting ${g.key}`,
    items: [
      ['Average miss (MAE)', mw(g.mae_mw)],
      ['Bias', signedMw(g.bias_mw)],
      ['Days', String(g.n)],
    ],
  }
})

function ByHour({ rows }: { rows: GroupMetrics[] }) {
  const data = rows.map((g) => ({ key: g.key, mae: g.mae_mw, bias: g.bias_mw, g }))
  const AXIS = axisFor(data.flatMap((r) => [r.mae, r.bias]), { zero: false })
  return (
    <Panel title="Each hour of the day" sub="Whether the forecast is worse overnight than in the afternoon, averaged over all 31 days.">
      <div className="chart short" role="img" aria-label="Forecast bias and average miss by hour of day">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="key" interval={3} tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tickFormatter={gwTick} width={64} tick={axisTick} tickLine={false} axisLine={false} domain={AXIS.domain} ticks={AXIS.ticks} />
            <Tooltip content={hourTooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
            <Line dataKey="mae" stroke={COLORS.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="bias" stroke={COLORS.bias} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ label: 'Average miss (MAE)', color: COLORS.ink }, { label: 'Bias', color: COLORS.bias }]} />
    </Panel>
  )
}

function Histogram({ a }: { a: AccuracyResponse }) {
  const total = a.error_histogram.reduce((s, b) => s + b.count, 0)
  const data = a.error_histogram.map((b) => ({ ...b, label: `${b.from_mw / 1000}`, share: b.count / total }))
  const tooltip = makeTooltip((d) => ({
    title: `${signedMw(d.from_mw as number)} to ${signedMw(d.to_mw as number)}`,
    items: [
      ['Hours', String(d.count)],
      ['Share', pct((d.share as number) * 100)],
    ],
  }))
  return (
    <Panel title="How big are the misses?" sub="Every scored hour, grouped by forecast error. Right of zero means the forecast was too high.">
      <div className="chart short" role="img" aria-label="Histogram of hourly forecast errors">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 16, left: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} label={{ value: 'Forecast error, GW (from the start of each bin)', position: 'insideBottom', offset: -12, fill: COLORS.muted, fontSize: 12 }} />
            <YAxis width={40} tick={axisTick} tickLine={false} axisLine={false} />
            <Tooltip content={tooltip} cursor={{ fill: 'rgba(15,43,54,0.06)' }} />
            <Bar dataKey="count" isAnimationActive={false}>
              {data.map((b) => (
                <Cell key={b.from_mw} fill={b.from_mw >= 0 ? COLORS.bias : COLORS.forecast} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="sub" style={{ margin: '12px 0 0' }}>
        Half of all hours were off by less than <span className="mono">{mw(a.overall.p50_abs_error_mw)}</span>; the worst 5% by more than{' '}
        <span className="mono">{mw(a.overall.p95_abs_error_mw)}</span>; the worst single hour by <span className="mono">{mw(a.overall.max_abs_error_mw)}</span>.
      </p>
    </Panel>
  )
}

function Horizon({ horizon, failed }: { horizon: HorizonResponse | null; failed?: string }) {
  const MIN_N = 100
  const rows = horizon?.buckets.filter((b) => b.n >= MIN_N).map((b) => ({ ...b, label: `${b.from_h}–${b.to_h} h` })) ?? []
  const AXIS = axisFor(rows.flatMap((r) => [r.mae_mw, r.rmse_mw, r.bias_mw]), { zero: false })
  const allHigh = rows.every((r) => r.bias_mw > 0)
  const tooltip = makeTooltip((d) => ({
    title: `Released ${d.label} before the hour`,
    items: [
      ['Average miss (MAE)', mw(d.mae_mw as number)],
      ['RMSE', mw(d.rmse_mw as number)],
      ['Bias', signedMw(d.bias_mw as number)],
      ['Forecasts', count(d.n as number)],
    ],
  }))
  return (
    <Panel title="Does waiting for a later forecast help?" sub="Every forecast released in January, scored by how far ahead of the hour it was issued. Later releases should be better.">
      {failed && <Notice error title="Couldn't load lead-time accuracy">{failed}</Notice>}
      {!horizon && !failed && <Skeleton height={260} />}
      {rows.length > 0 && (
        <>
          <div className="chart short" role="img" aria-label="Forecast error by lead time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={COLORS.grid} vertical={false} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
                <YAxis tickFormatter={gwTick} width={64} tick={axisTick} tickLine={false} axisLine={false} domain={AXIS.domain} ticks={AXIS.ticks} />
                <Tooltip content={tooltip} cursor={{ stroke: COLORS.ink, strokeDasharray: '3 3' }} />
                <Line dataKey="mae_mw" stroke={COLORS.ink} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                <Line dataKey="rmse_mw" stroke={COLORS.forecast} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                <Line dataKey="bias_mw" stroke={COLORS.bias} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <Legend
            items={[
              { label: 'Average miss (MAE)', color: COLORS.ink },
              { label: 'RMSE', color: COLORS.forecast },
              { label: 'Bias', color: COLORS.bias },
            ]}
          />
          <p className="sub" style={{ margin: '12px 0 0' }}>
            Error grows from <span className="mono">{mw(rows[0].mae_mw)}</span> within 6 hours to <span className="mono">{mw(rows[rows.length - 1].mae_mw)}</span> at{' '}
            {rows[rows.length - 1].label}, so a later release does help.{' '}
            {allHigh && <>The forecast is too high at every lead time (bias {signedMw(Math.min(...rows.map((r) => r.bias_mw)))} to {signedMw(Math.max(...rows.map((r) => r.bias_mw)))}), so waiting does not fix the bias. </>}
            Buckets with fewer than {MIN_N} forecasts are left out.
          </p>
        </>
      )}
    </Panel>
  )
}

function BiasCorrectionCard({ a }: { a: AccuracyResponse }) {
  const b = a.bias_correction
  return (
    <Panel title="Can the bias be corrected?" sub="Test: before each delivery day, subtract the average bias of the days already finished. No peeking at the day being scored.">
      {b ? (
        <>
          <dl className="grid stats" style={{ margin: 0 }}>
            <Stat label="Average miss, as published" value={mw(b.mae_raw_mw)} />
            <Stat label="Average miss, bias removed" value={mw(b.mae_adjusted_mw)} hint={`${pct(b.mae_improvement_pct, 0)} lower`} />
          </dl>
          <p className="sub" style={{ margin: '12px 0 0' }}>
            Scored on {b.n_days_evaluated} days (the first {b.min_history_days} have too little history). The correction helped on {b.days_improved} of them and cut the remaining bias from{' '}
            <span className="mono">{signedMw(b.bias_raw_mw)}</span> to <span className="mono">{signedMw(b.bias_adjusted_mw)}</span>. One winter month is a small sample, so treat this as a strong
            hint, not a guarantee.
          </p>
        </>
      ) : (
        <p className="sub">Not enough days to test.</p>
      )}
    </Panel>
  )
}

function ReliabilityCard({ a }: { a: AccuracyResponse }) {
  const b = a.band
  return (
    <Panel title="Can you trust the likely-range band?" sub={`The band on the forecast chart is the 10th to 90th percentile of January errors, so it should hold ${pct(b.level * 100, 0)} of outcomes.`}>
      <dl className="grid stats" style={{ margin: 0 }}>
        <Stat label="Target" value={pct(b.level * 100, 0)} />
        <Stat label="January, in-sample" value={pct(b.in_sample_coverage * 100)} hint="true by construction" />
        <Stat label="Held out, day by day" value={pct(b.leave_one_day_out_coverage * 100)} hint="band rebuilt without the day it is judged on" />
      </dl>
      <p className="sub" style={{ margin: '12px 0 0' }}>
        The held-out figure is the honest one. It lands a little under the target, so read the band as {gw(Math.abs(b.error_p90_mw - b.error_p10_mw))} wide at roughly {pct(b.leave_one_day_out_coverage * 100, 0)} confidence.
      </p>
    </Panel>
  )
}
