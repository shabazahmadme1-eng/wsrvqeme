import type { TooltipContentProps } from 'recharts'

export const COLORS = {
  forecast: '#0b7a8f',
  ink: '#0f2b36',
  muted: '#4a6670',
  grid: '#c9d6d4',
  bias: '#c97a10',
}

/** Axis with a round upper bound and one tick per `step`, so labels like "13.5 GW" never appear. */
export function axisFor(values: number[], opts: { zero?: boolean } = {}) {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const floor = opts.zero === false ? Math.min(0, lo) : 0
  const step = [500, 1000, 2000, 2500, 5000, 10000].find((s) => (hi - floor) / s <= 5) ?? 10000
  const min = Math.floor(floor / step) * step
  const max = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(v)
  return { domain: [min, max] as [number, number], ticks }
}

export const gwTick = (v: number) => `${+(v / 1000).toFixed(1)} GW`

/** Tooltip shell shared by every chart: a title and a list of label/value rows. */
export function makeTooltip(rows: (datum: Record<string, unknown>) => { title: string; items: [string, string][] }) {
  return function ChartTooltip({ active, payload }: TooltipContentProps) {
    if (!active || !payload?.length) return null
    const { title, items } = rows(payload[0].payload as Record<string, unknown>)
    return (
      <div className="tooltip">
        <div className="when">{title}</div>
        <dl>
          {items.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
}
