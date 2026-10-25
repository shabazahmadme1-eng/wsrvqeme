import type { Meta } from './api'
import { count, dayLabel } from './format'
import { Panel } from './ui'

export function MethodView({ meta }: { meta: Meta }) {
  const c = meta.coverage
  return (
    <div className="stack">
      <Panel title="How this tool works">
        <div className="prose">
          <h3>The decision it supports</h3>
          <p>
            A UK supplier buys the power it will need tomorrow in the day-ahead market, and must decide how much to buy before that market closes. Wind is the least predictable supply, so
            the question each morning is: how much wind should we count on tomorrow, and how wrong could that be?
          </p>

          <h3>Where the numbers come from</h3>
          <ul>
            <li>
              <strong>Forecast:</strong> Elexon BMRS dataset <span className="mono">WINDFOR</span>, the national wind forecast. Each release is hourly and looks about two to three days ahead; there
              are roughly eight releases a day.
            </li>
            <li>
              <strong>Actual:</strong> Elexon BMRS dataset <span className="mono">FUELHH</span>, half-hourly generation, fuel type <span className="mono">WIND</span>.
            </li>
            <li>Both are national totals. The January analysis uses no weather, demand or price data.</li>
            <li>
              The <strong>Live now</strong> tab is a separate extra: it adds today's Elexon data and live weather from Open-Meteo for six wind-farm areas. It does not feed any figure on the other pages.
            </li>
          </ul>

          <h3>How a decision is replayed</h3>
          <ul>
            <li>
              For a delivery day D, the decision is taken on D−1 by a cutoff time you choose. Only forecasts released at or before that moment are allowed, and the latest of them is used for
              each hour.
            </li>
            <li>Forecasts released after the hour they describe are dropped. They are hindcasts nobody could act on.</li>
            <li>Each forecast hour is scored against the mean of the two half-hours it covers.</li>
            <li>
              Decisions made in January 2026 are for delivery {dayLabel(c.delivery_from)} to {dayLabel(c.delivery_to)}, which is {count(31)} delivery days.
            </li>
          </ul>

          <h3>Reading the error figures</h3>
          <ul>
            <li>
              <strong>Error</strong> is forecast minus actual, so a positive error means the forecast was too high.
            </li>
            <li>
              <strong>MAE</strong> is the average size of the miss. <strong>RMSE</strong> is similar but punishes big misses more. <strong>Bias</strong> is the average signed error.
            </li>
            <li>
              <strong>The likely-range band</strong> applies the 10th–90th percentile of January errors to the forecast. It describes how January behaved, and is checked against held-out days on the
              accuracy page.
            </li>
            <li>
              <strong>The naive guess</strong> repeats the same hour from the last day already complete at the cutoff. A forecast has to beat it to earn its keep.
            </li>
          </ul>

          <h3>What to be careful about</h3>
          <ul>
            <li>One winter month is a small sample. Weather regimes in other seasons can behave differently.</li>
            <li>
              The forecast runs consistently high against the metered wind figure. We don't know why. One possibility is that the two series cover different sets of wind farms, but we have not
              verified that.
            </li>
            <li>The cutoff is an assumption you control. The real day-ahead gate closes at a fixed time, and moving the handle shows how much that time matters.</li>
            <li>Actuals are shown only to judge the forecast afterwards. They are not available when the decision is made.</li>
          </ul>
        </div>
      </Panel>

      <Panel title="Data on hand">
        <dl className="facts">
          <dt>Forecast rows</dt>
          <dd>{count(meta.n_forecast_rows)}</dd>
          <dt>Actual half-hours</dt>
          <dd>{count(meta.n_actual_half_hours)}</dd>
          <dt>Releases per day, UTC</dt>
          <dd>{meta.publish_times_utc.join(', ')}</dd>
          <dt>Snapshot taken</dt>
          <dd>{meta.data_fetched_at ?? 'unknown'}</dd>
        </dl>
      </Panel>
    </div>
  )
}
