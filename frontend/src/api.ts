// Types mirror backend/app/schemas.py. All timestamps are ISO strings in UTC.

export interface Metrics {
  n: number
  mean_actual_mw: number
  mean_forecast_mw: number
  bias_mw: number
  bias_pct: number
  mae_mw: number
  mae_pct: number
  rmse_mw: number
  mape_pct: number
  p50_abs_error_mw: number
  p90_abs_error_mw: number
  p95_abs_error_mw: number
  max_abs_error_mw: number
}

export interface Meta {
  coverage: {
    decisions_from: string
    decisions_to: string
    delivery_from: string
    delivery_to: string
    actuals_to: string
  }
  publish_times_utc: string[]
  default_cutoff: string
  data_fetched_at: string | null
  n_forecast_rows: number
  n_actual_half_hours: number
  notes: string[]
}

export interface DecisionPoint {
  target: string
  forecast_mw: number
  published: string
  horizon_h: number
  low_mw: number
  high_mw: number
  previous_forecast_mw: number | null
  revision_mw: number | null
  actual_mw: number | null
}

export interface BandInfo {
  level: number
  error_p10_mw: number
  error_p90_mw: number
  in_sample_coverage: number
  leave_one_day_out_coverage: number
  n_days: number
}

export interface DecisionResponse {
  delivery_date: string
  cutoff_utc: string
  decision_time: string
  points: DecisionPoint[]
  summary: {
    mean_mw: number
    energy_mwh: number
    peak_mw: number
    peak_hour: string
    trough_mw: number
    trough_hour: string
    mean_revision_mw: number | null
  }
  band: BandInfo
  historical_bias_mw: number
  day_accuracy: Metrics | null
}

export interface PublicationsResponse {
  delivery_date: string
  decision_day: string
  publications: string[]
  previous_release: string | null
}

export interface GroupMetrics {
  key: string
  n: number
  mae_mw: number
  rmse_mw: number
  bias_mw: number
  mean_actual_mw: number
}

export interface AccuracyResponse {
  cutoff_utc: string
  overall: Metrics
  baseline: { name: string; description: string; metrics: Metrics; skill_vs_baseline_pct: number }
  band: BandInfo
  bias_correction: {
    min_history_days: number
    n_days_evaluated: number
    n_points: number
    mae_raw_mw: number
    mae_adjusted_mw: number
    mae_improvement_pct: number
    bias_raw_mw: number
    bias_adjusted_mw: number
    days_improved: number
  } | null
  by_delivery_day: GroupMetrics[]
  by_hour_of_day: GroupMetrics[]
  error_histogram: { from_mw: number; to_mw: number; count: number }[]
}

export interface HorizonResponse {
  bucket_h: number
  buckets: { from_h: number; to_h: number; n: number; mae_mw: number; rmse_mw: number; bias_mw: number }[]
}

export interface LiveResponse {
  as_of: string
  forecast_published: string | null
  forecast: { target: string; forecast_mw: number; low_mw: number | null; high_mw: number | null }[]
  actuals: { start: string; generation_mw: number }[]
  weather: {
    observed_at: string | null
    sites: { name: string; latitude: number; longitude: number; wind_speed_100m_ms: number | null; gust_10m_ms: number | null; direction_deg: number | null }[]
    index: { time: string; wind_speed_100m_ms: number }[]
    source: string
  } | null
  band: BandInfo | null
  errors: { elexon?: string; weather?: string }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string, params: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  const resp = await fetch(`/api/${path}${query ? `?${query}` : ''}`, { signal })
  if (!resp.ok) {
    let detail = resp.statusText
    try {
      detail = (await resp.json()).detail ?? detail
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(resp.status, typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return resp.json() as Promise<T>
}

export const api = {
  meta: (s?: AbortSignal) => get<Meta>('meta', {}, s),
  decision: (deliveryDate: string, cutoff: string, s?: AbortSignal) =>
    get<DecisionResponse>('decision', { delivery_date: deliveryDate, cutoff }, s),
  publications: (deliveryDate: string, s?: AbortSignal) =>
    get<PublicationsResponse>('publications', { delivery_date: deliveryDate }, s),
  accuracy: (cutoff: string, s?: AbortSignal) => get<AccuracyResponse>('accuracy', { cutoff }, s),
  live: (s?: AbortSignal) => get<LiveResponse>('live', {}, s),
  horizon: (bucketH: number, s?: AbortSignal) => get<HorizonResponse>('accuracy/horizon', { bucket_h: bucketH }, s),
}
