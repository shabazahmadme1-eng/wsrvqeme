import { useEffect, useState } from 'react'
import { AccuracyView } from './AccuracyView'
import { api } from './api'
import { DecisionView } from './DecisionView'
import { clockToMinutes } from './format'
import { LiveView } from './LiveView'
import { MethodView } from './MethodView'
import { Notice, Skeleton } from './ui'
import { useRemote } from './useApi'

const TABS = [
  {
    id: 'buying',
    label: 'Buying forecast',
    eyebrow: 'January 2026 decisions',
    blurb: 'The wind forecast you would have had when the day-ahead purchase was due, and how far off it is likely to be.',
  },
  {
    id: 'accuracy',
    label: 'Forecast accuracy',
    eyebrow: 'January 2026 decisions',
    blurb: 'Every January decision replayed as it would have been made, then scored against what the wind actually did.',
  },
  {
    id: 'live',
    label: 'Live now',
    eyebrow: 'Today, beyond the January brief',
    blurb: "Today's national wind output and the latest forecast, with the weather behind them.",
  },
  {
    id: 'method',
    label: 'Method',
    eyebrow: 'How it works',
    blurb: 'Where the numbers come from, how a decision is replayed, and what to be careful about.',
  },
] as const
type TabId = (typeof TABS)[number]['id']

const tabFromHash = (): TabId => TABS.find((t) => `#${t.id}` === window.location.hash)?.id ?? 'buying'

function Turbine() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M19 20 V36" />
      <g className="blades">
        <path d="M19 20 L19 3" />
        <path d="M19 20 L33 28" />
        <path d="M19 20 L5 28" />
        <circle cx="19" cy="20" r="2.4" fill="currentColor" />
      </g>
    </svg>
  )
}

export default function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const meta = useRemote((s) => api.meta(s), [])
  // Shared by both views so the cutoff chosen on one page carries over to the other.
  // Until the user moves it, it is the server's default, derived rather than copied into state.
  const [chosenCutoff, setCutoff] = useState<number | null>(null)
  const cutoff = chosenCutoff ?? (meta.data ? clockToMinutes(meta.data.default_cutoff) : null)

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Turbine />
            <div>
              <h1>Wind Day-Ahead Desk</h1>
              <p>GB national wind forecast for the next day's power purchase, and how far to trust it</p>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} className="tab" href={`#${t.id}`} aria-current={tab === t.id ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div className="shell">
        <div className="page-head">
          <p className="eyebrow">{current.eyebrow}</p>
          <h2>{current.label}</h2>
          <p>{current.blurb}</p>
        </div>

        <main>
          {meta.error && (
            <Notice error title="Couldn't reach the data service">
              {meta.error.message}. Check that the backend is running and reload the page.
            </Notice>
          )}
          {!meta.data || cutoff === null ? (
            !meta.error && <Skeleton height={420} />
          ) : tab === 'buying' ? (
            <DecisionView meta={meta.data} cutoff={cutoff} onCutoff={setCutoff} />
          ) : tab === 'accuracy' ? (
            <AccuracyView cutoff={cutoff} onCutoff={setCutoff} />
          ) : tab === 'live' ? (
            <LiveView />
          ) : (
            <MethodView meta={meta.data} />
          )}
        </main>

        <footer className="footer">
          <span>Data: Elexon BMRS (WINDFOR forecasts, FUELHH outturn); live weather by Open-Meteo.com. All times UTC.</span>
          {meta.data?.data_fetched_at && <span>Snapshot {meta.data.data_fetched_at.slice(0, 10)}</span>}
        </footer>
      </div>
    </>
  )
}
