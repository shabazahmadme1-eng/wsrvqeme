"""Response models. They double as the API documentation served at /docs."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


class Metrics(BaseModel):
    """Forecast error summary. Error = forecast - actual, so positive means the wind forecast was too high."""

    n: int = Field(description="number of hourly forecast/actual pairs")
    mean_actual_mw: float
    mean_forecast_mw: float
    bias_mw: float = Field(description="mean error; positive = forecast above what was generated")
    bias_pct: float | None = Field(description="bias as % of mean actual output (null if that mean is 0)")
    mae_mw: float = Field(description="mean absolute error")
    mae_pct: float | None = Field(description="MAE as % of mean actual output (null if that mean is 0)")
    rmse_mw: float
    mape_pct: float | None = Field(description="mean of |error| / actual over hours with output > 0, in %")
    p50_abs_error_mw: float
    p90_abs_error_mw: float
    p95_abs_error_mw: float
    max_abs_error_mw: float


class Coverage(BaseModel):
    decisions_from: date
    decisions_to: date
    delivery_from: date
    delivery_to: date
    actuals_to: datetime


class Meta(BaseModel):
    coverage: Coverage
    publish_times_utc: list[str] = Field(description="HH:MM times of day at which forecasts were published")
    default_cutoff: str
    data_fetched_at: str | None
    n_forecast_rows: int
    n_actual_half_hours: int
    notes: list[str]


class DecisionPoint(BaseModel):
    target: datetime = Field(description="start of the delivery hour (UTC)")
    forecast_mw: float
    published: datetime = Field(description="when the forecast used here was published")
    horizon_h: float = Field(description="hours between publication and the start of the delivery hour")
    low_mw: float | None = Field(description="lower end of the 80% band, floored at 0; null until enough days have finished")
    high_mw: float | None
    previous_forecast_mw: float | None = Field(description="the forecast before the latest update, if any")
    revision_mw: float | None = Field(description="latest minus previous forecast")
    actual_mw: float | None = Field(description="what was actually generated (hindcast only, unknown at decision time)")


class DaySummary(BaseModel):
    hours: int = Field(description="hours of the delivery day that had a forecast by the cutoff; the totals cover only these")
    mean_mw: float
    energy_mwh: float
    peak_mw: float
    peak_hour: datetime
    trough_mw: float
    trough_hour: datetime
    mean_revision_mw: float | None


class BandInfo(BaseModel):
    level: float = Field(description="nominal probability mass inside the band")
    error_p10_mw: float
    error_p90_mw: float
    in_sample_coverage: float
    leave_one_day_out_coverage: float
    walk_forward_coverage: float | None = Field(
        description="coverage when each day's band is built only from days finished before its decision (as on the Buying page)"
    )
    walk_forward_days: int
    n_days: int


class DecisionBand(BaseModel):
    """Built only from delivery days already finished at the decision time."""

    level: float
    error_p10_mw: float
    error_p90_mw: float
    bias_mw: float = Field(description="average error over those days; positive = forecast ran high")
    history_days: int
    history_from: date
    history_to: date


class DecisionResponse(BaseModel):
    delivery_date: date
    cutoff_utc: str
    decision_time: datetime
    points: list[DecisionPoint]
    missing_hours: list[datetime] = Field(description="hours of the delivery day that no release had reached by the cutoff")
    summary: DaySummary
    band: DecisionBand | None = Field(description="null while fewer than 3 delivery days had finished")
    day_accuracy: Metrics | None = Field(description="how this specific day turned out (hindcast)")


class PublicationsResponse(BaseModel):
    delivery_date: date
    decision_day: date = Field(description="the day before delivery, when the purchase is decided")
    publications: list[datetime] = Field(description="every forecast release on the decision day, UTC")
    previous_release: datetime | None = Field(
        description="the last release before the decision day began; it is the latest forecast in hand for an early-morning cutoff"
    )


class GroupMetrics(BaseModel):
    key: str
    n: int
    mae_mw: float
    rmse_mw: float
    bias_mw: float
    mean_actual_mw: float


class HistogramBin(BaseModel):
    from_mw: float
    to_mw: float
    count: int


class BiasCorrection(BaseModel):
    """What if the buyer subtracted the bias observed on earlier delivery days? Walk-forward, no look-ahead."""

    min_history_days: int
    n_days_evaluated: int
    n_points: int
    mae_raw_mw: float
    mae_adjusted_mw: float
    mae_improvement_pct: float
    bias_raw_mw: float
    bias_adjusted_mw: float
    days_improved: int


class Baseline(BaseModel):
    name: str
    description: str
    metrics: Metrics
    skill_vs_baseline_pct: float = Field(description="% reduction in MAE of the forecast versus this baseline")


class AccuracyResponse(BaseModel):
    cutoff_utc: str
    overall: Metrics
    baseline: Baseline
    band: BandInfo
    bias_correction: BiasCorrection | None
    by_delivery_day: list[GroupMetrics]
    by_hour_of_day: list[GroupMetrics]
    error_histogram: list[HistogramBin]


class HorizonBucket(BaseModel):
    from_h: int
    to_h: int
    n: int
    mae_mw: float
    rmse_mw: float
    bias_mw: float


class HorizonResponse(BaseModel):
    bucket_h: int
    buckets: list[HorizonBucket]


# ------------------------------------------------------------------------------------------- live view


class LiveForecastPoint(BaseModel):
    target: datetime
    forecast_mw: float
    low_mw: float | None = Field(description="January-derived likely range; indicative only")
    high_mw: float | None


class LiveActualPoint(BaseModel):
    start: datetime = Field(description="start of the half-hour")
    generation_mw: float


class WeatherSite(BaseModel):
    name: str
    latitude: float
    longitude: float
    wind_speed_100m_ms: float | None
    gust_10m_ms: float | None
    direction_deg: int | None


class WeatherIndexPoint(BaseModel):
    time: datetime
    wind_speed_100m_ms: float = Field(description="unweighted mean over the sites")


class LiveWeather(BaseModel):
    observed_at: datetime | None
    sites: list[WeatherSite]
    index: list[WeatherIndexPoint]
    source: str


class LiveNowCheck(BaseModel):
    """The latest metered half-hour against the forecast made before its hour began."""

    actual_start: datetime
    actual_mw: float = Field(description="output in the latest metered half-hour")
    hour: datetime
    forecast_mw: float
    published: datetime = Field(description="the latest release published before `hour` began")


class LiveResponse(BaseModel):
    as_of: datetime = Field(description="when the Elexon data was fetched (responses are cached for 5 minutes)")
    forecast_published: datetime | None
    forecast: list[LiveForecastPoint]
    actuals: list[LiveActualPoint]
    now_check: LiveNowCheck | None
    weather: LiveWeather | None
    band: BandInfo | None
    errors: dict[str, str] = Field(description="per-source failures; the rest of the response is still returned")
