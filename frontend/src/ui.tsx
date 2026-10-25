import type { ReactNode } from 'react'

export function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        <span className={`value${warn ? ' warn' : ''}`}>{value}</span>
        {hint && <span className="hint">{hint}</span>}
      </dd>
    </div>
  )
}

export function Notice({ title, children, error }: { title: string; children?: ReactNode; error?: boolean }) {
  return (
    <div className={`notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children}
    </div>
  )
}

export function Skeleton({ height = 200 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden="true" />
}

export function Panel({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {sub && <p className="sub">{sub}</p>}
      {children}
    </section>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean; band?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span
          key={i.label}
          className={i.dashed ? 'dashed' : i.band ? 'band' : undefined}
          style={{ ['--swatch' as string]: i.color }}
        >
          {i.label}
        </span>
      ))}
    </div>
  )
}
