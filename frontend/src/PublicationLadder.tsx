import { clock, clockToMinutes, dayLabel, duration, minutesToClock } from './format'

const DAY_MINUTES = 24 * 60
const LAST_CUTOFF = DAY_MINUTES - 15
const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21]

interface Props {
  decisionDay: string
  publications: string[]
  /** last release before the decision day began (the forecast in hand for an early-morning cutoff) */
  previousRelease: string | null
  cutoff: number
  onChange: (minutes: number) => void
}

/**
 * The day before delivery as a timeline: every forecast release is a marker, and the handle is the
 * moment the purchase must be decided. Everything left of the handle is knowable; the marker closest
 * to it (the latest release at or before it) is the forecast the decision is based on.
 */
export function PublicationLadder({ decisionDay, publications, previousRelease, cutoff, onChange }: Props) {
  const releases = publications.map((iso) => ({ iso, minutes: clockToMinutes(clock(iso)) })).sort((a, b) => a.minutes - b.minutes)
  const latest = [...releases].reverse().find((r) => r.minutes <= cutoff)
  // Before the first release of the day, the forecast in hand is the previous day's last one.
  const carried = !latest && previousRelease ? previousRelease : null
  const carriedAge = carried ? cutoff + DAY_MINUTES - clockToMinutes(clock(carried)) : 0
  const left = (minutes: number) => `${(minutes / DAY_MINUTES) * 100}%`
  const later = releases.filter((r) => r.minutes > cutoff)

  return (
    <div>
      <div className="ladder">
        <div className="ladder-track" aria-hidden="true">
          <div className="ladder-known" style={{ width: left(cutoff) }} />
        </div>
        {HOUR_LABELS.map((h) => (
          <div key={h} className="ladder-hour" style={{ left: left(h * 60) }} aria-hidden="true">
            {String(h).padStart(2, '0')}
          </div>
        ))}
        {releases.map((r) => (
          <div
            key={r.iso}
            className={`ladder-pub${r.minutes <= cutoff ? ' known' : ''}${r === latest ? ' latest' : ''}`}
            style={{ left: left(r.minutes) }}
            aria-hidden="true"
          >
            <span>{minutesToClock(r.minutes)}</span>
          </div>
        ))}
        <input
          type="range"
          min={0}
          max={DAY_MINUTES}
          step={15}
          value={cutoff}
          onChange={(e) => onChange(Math.min(Number(e.target.value), LAST_CUTOFF))}
          aria-label={`Decide by, on ${dayLabel(decisionDay)}`}
          aria-valuetext={`${minutesToClock(cutoff)} on ${dayLabel(decisionDay)}`}
        />
      </div>
      <div className="ladder-caption">
        <span>
          Decide by <strong className="mono">{minutesToClock(cutoff)}</strong> on {dayLabel(decisionDay)}
        </span>
        <span>
          {latest ? (
            <>
              Latest forecast in hand: released <strong className="mono">{minutesToClock(latest.minutes)}</strong>,{' '}
              {duration(cutoff - latest.minutes)} before the cutoff
            </>
          ) : carried ? (
            <>
              Latest forecast in hand: released <strong className="mono">{clock(carried)}</strong> on {dayLabel(carried)}, {duration(carriedAge)} before the cutoff
            </>
          ) : (
            <>No forecast had been released yet</>
          )}
        </span>
        {later.length > 0 && <span>Not yet released: {later.map((r) => minutesToClock(r.minutes)).join(', ')}</span>}
      </div>
    </div>
  )
}
