"""Decision backtest and forecast-error statistics.

Vocabulary used throughout:
  * delivery day  - the UK day (00:00-24:00, == UTC in January) whose power is bought.
  * cutoff        - time of day on the *previous* day by which the day-ahead purchase must be decided.
  * decision time - (delivery day - 1) at the cutoff. Only forecasts published at or before it may be used.
  * error         - forecast minus actual (MW). Positive = the wind forecast was too optimistic.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from . import schemas
from .store import Dataset

# Purchase decisions are made in January 2026, one day before delivery: delivery runs 2 Jan .. 1 Feb.
DECISION_FROM = date(2026, 1, 1)
DECISION_TO = date(2026, 1, 31)
FIRST_DELIVERY = DECISION_FROM + timedelta(days=1)
LAST_DELIVERY = DECISION_TO + timedelta(days=1)
DEFAULT_CUTOFF = time(9, 0)

BAND_LEVEL = 0.8  # the band spans the 10th to 90th percentile of past errors
MIN_BIAS_HISTORY_DAYS = 3
HISTOGRAM_BIN_MW = 1000


@dataclass(frozen=True)
class Point:
    """One delivery hour, as seen from the decision time."""

    target: datetime
    forecast: float
    published: datetime
    horizon_h: float
    previous_forecast: float | None
    actual: float | None
    persistence: float | None

    @property
    def error(self) -> float | None:
        return None if self.actual is None else self.forecast - self.actual


# --------------------------------------------------------------------------------------- decisions


def decision_time(delivery: date, cutoff: time) -> datetime:
    return datetime.combine(delivery - timedelta(days=1), cutoff, tzinfo=timezone.utc)


def delivery_hours(delivery: date) -> list[datetime]:
    start = datetime.combine(delivery, time(0), tzinfo=timezone.utc)
    return [start + timedelta(hours=h) for h in range(24)]


def delivery_dates() -> list[date]:
    return [FIRST_DELIVERY + timedelta(days=i) for i in range((LAST_DELIVERY - FIRST_DELIVERY).days + 1)]


def _persistence(ds: Dataset, target: datetime, as_of: datetime) -> float | None:
    """Naive baseline: the output of the same hour on the most recent day that was complete at `as_of`."""
    candidate = target - timedelta(days=1)
    while candidate + timedelta(hours=1) > as_of:
        candidate -= timedelta(days=1)
    return ds.hourly_actual(candidate)


def build_points(ds: Dataset, delivery: date, cutoff: time) -> list[Point]:
    """The latest forecast available at the decision time for each hour of the delivery day."""
    as_of = decision_time(delivery, cutoff)
    points = []
    for target in delivery_hours(delivery):
        known = ds.forecasts_as_of(target, as_of)
        if not known:
            continue
        published, forecast = known[-1]
        points.append(
            Point(
                target=target,
                forecast=forecast,
                published=published,
                horizon_h=(target - published).total_seconds() / 3600,
                previous_forecast=known[-2][1] if len(known) > 1 else None,
                actual=ds.hourly_actual(target),
                persistence=_persistence(ds, target, as_of),
            )
        )
    return points


def backtest(ds: Dataset, cutoff: time) -> dict[date, list[Point]]:
    """Every January decision, replayed exactly as it would have been taken."""
    return {d: pts for d in delivery_dates() if (pts := build_points(ds, d, cutoff))}


def _scored(days: dict[date, list[Point]]) -> list[Point]:
    return [p for pts in days.values() for p in pts if p.actual is not None]


# ---------------------------------------------------------------------------------------- statistics


def percentile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolated percentile (same convention as numpy's default). `q` in [0, 1]."""
    if not sorted_values:
        raise ValueError("percentile of empty sequence")
    pos = q * (len(sorted_values) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def compute_metrics(pairs: list[tuple[float, float]]) -> schemas.Metrics | None:
    """`pairs` are (forecast, actual) in MW."""
    if not pairs:
        return None
    n = len(pairs)
    errors = [f - a for f, a in pairs]
    abs_errors = sorted(abs(e) for e in errors)
    mean_actual = sum(a for _, a in pairs) / n
    mae = sum(abs_errors) / n
    bias = sum(errors) / n
    return schemas.Metrics(
        n=n,
        mean_actual_mw=mean_actual,
        mean_forecast_mw=sum(f for f, _ in pairs) / n,
        bias_mw=bias,
        bias_pct=100 * bias / mean_actual,
        mae_mw=mae,
        mae_pct=100 * mae / mean_actual,
        rmse_mw=math.sqrt(sum(e * e for e in errors) / n),
        mape_pct=100 * sum(abs(f - a) / a for f, a in pairs if a > 0) / n,
        p50_abs_error_mw=percentile(abs_errors, 0.5),
        p90_abs_error_mw=percentile(abs_errors, 0.9),
        p95_abs_error_mw=percentile(abs_errors, 0.95),
        max_abs_error_mw=abs_errors[-1],
    )


def _pairs(points: list[Point]) -> list[tuple[float, float]]:
    return [(p.forecast, p.actual) for p in points if p.actual is not None]


def _group_metrics(key: str, points: list[Point]) -> schemas.GroupMetrics:
    m = compute_metrics(_pairs(points))
    assert m is not None
    return schemas.GroupMetrics(
        key=key, n=m.n, mae_mw=m.mae_mw, rmse_mw=m.rmse_mw, bias_mw=m.bias_mw, mean_actual_mw=m.mean_actual_mw
    )


def error_band(days: dict[date, list[Point]]) -> schemas.BandInfo | None:
    """Empirical 80% band for the error, plus an honest check of how well it generalises.

    `leave_one_day_out_coverage` recomputes the band without day D and asks whether day D's errors fall
    inside it. In-sample coverage is ~80% by construction; the leave-one-out figure is the real test.
    """
    scored = {d: [p.error for p in pts if p.error is not None] for d, pts in days.items()}
    scored = {d: errs for d, errs in scored.items() if errs}
    if len(scored) < 2:
        return None
    lo_q, hi_q = (1 - BAND_LEVEL) / 2, 1 - (1 - BAND_LEVEL) / 2
    everything = sorted(e for errs in scored.values() for e in errs)
    p10, p90 = percentile(everything, lo_q), percentile(everything, hi_q)
    in_sample = sum(p10 <= e <= p90 for e in everything) / len(everything)

    hits = total = 0
    for day, errs in scored.items():
        others = sorted(e for d, es in scored.items() if d != day for e in es)
        lo, hi = percentile(others, lo_q), percentile(others, hi_q)
        hits += sum(lo <= e <= hi for e in errs)
        total += len(errs)
    return schemas.BandInfo(
        level=BAND_LEVEL,
        error_p10_mw=p10,
        error_p90_mw=p90,
        in_sample_coverage=in_sample,
        leave_one_day_out_coverage=hits / total,
        n_days=len(scored),
    )


def bias_correction(days: dict[date, list[Point]]) -> schemas.BiasCorrection | None:
    """Walk-forward test of "subtract the bias we have seen so far".

    For delivery day D the bias estimate is the average daily error of days <= D-2 (day D-1 is still
    in progress at the D-1 cutoff, so it is not yet knowable). Needs MIN_BIAS_HISTORY_DAYS of history.
    """
    daily_bias: dict[date, float] = {}
    for d, pts in days.items():
        errs = [p.error for p in pts if p.error is not None]
        if errs:
            daily_bias[d] = sum(errs) / len(errs)

    raw_pairs: list[tuple[float, float]] = []
    adj_pairs: list[tuple[float, float]] = []
    improved = evaluated = 0
    for d in sorted(days):
        history = [b for hd, b in daily_bias.items() if hd <= d - timedelta(days=2)]
        if len(history) < MIN_BIAS_HISTORY_DAYS:
            continue
        shift = sum(history) / len(history)
        scored = [p for p in days[d] if p.actual is not None]
        if not scored:
            continue
        evaluated += 1
        raw = [(p.forecast, p.actual) for p in scored]
        adj = [(p.forecast - shift, p.actual) for p in scored]
        raw_mae = sum(abs(f - a) for f, a in raw) / len(raw)
        adj_mae = sum(abs(f - a) for f, a in adj) / len(adj)
        improved += adj_mae < raw_mae
        raw_pairs += raw
        adj_pairs += adj
    if not evaluated:
        return None
    raw_m, adj_m = compute_metrics(raw_pairs), compute_metrics(adj_pairs)
    assert raw_m and adj_m
    return schemas.BiasCorrection(
        min_history_days=MIN_BIAS_HISTORY_DAYS,
        n_days_evaluated=evaluated,
        n_points=raw_m.n,
        mae_raw_mw=raw_m.mae_mw,
        mae_adjusted_mw=adj_m.mae_mw,
        mae_improvement_pct=100 * (raw_m.mae_mw - adj_m.mae_mw) / raw_m.mae_mw,
        bias_raw_mw=raw_m.bias_mw,
        bias_adjusted_mw=adj_m.bias_mw,
        days_improved=improved,
    )


# ---------------------------------------------------------------------------------- API-level views


def decision_view(ds: Dataset, delivery: date, cutoff: time) -> schemas.DecisionResponse | None:
    days = backtest(ds, cutoff)
    band = error_band(days)
    points = days.get(delivery)
    if not points or band is None:
        return None

    scored = _scored(days)
    bias = sum(p.error for p in scored) / len(scored)  # type: ignore[misc]

    # actual = forecast - error, so the band on the actual is [forecast - p90_error, forecast - p10_error].
    out_points = [
        schemas.DecisionPoint(
            target=p.target,
            forecast_mw=p.forecast,
            published=p.published,
            horizon_h=p.horizon_h,
            low_mw=p.forecast - band.error_p90_mw,
            high_mw=p.forecast - band.error_p10_mw,
            previous_forecast_mw=p.previous_forecast,
            revision_mw=None if p.previous_forecast is None else p.forecast - p.previous_forecast,
            actual_mw=p.actual,
        )
        for p in points
    ]
    peak = max(points, key=lambda p: p.forecast)
    trough = min(points, key=lambda p: p.forecast)
    revisions = [p.forecast - p.previous_forecast for p in points if p.previous_forecast is not None]
    summary = schemas.DaySummary(
        mean_mw=sum(p.forecast for p in points) / len(points),
        energy_mwh=sum(p.forecast for p in points),  # hourly MW averages x 1 h
        peak_mw=peak.forecast,
        peak_hour=peak.target,
        trough_mw=trough.forecast,
        trough_hour=trough.target,
        mean_revision_mw=sum(revisions) / len(revisions) if revisions else None,
    )
    return schemas.DecisionResponse(
        delivery_date=delivery,
        cutoff_utc=cutoff.strftime("%H:%M"),
        decision_time=decision_time(delivery, cutoff),
        points=out_points,
        summary=summary,
        band=band,
        historical_bias_mw=bias,
        day_accuracy=compute_metrics(_pairs(points)),
    )


def accuracy_view(ds: Dataset, cutoff: time) -> schemas.AccuracyResponse | None:
    days = backtest(ds, cutoff)
    scored = _scored(days)
    overall = compute_metrics(_pairs(scored))
    band = error_band(days)
    if overall is None or band is None:
        return None

    # Compare against the baseline on exactly the hours where the baseline exists.
    both = [p for p in scored if p.persistence is not None]
    base_m = compute_metrics([(p.persistence, p.actual) for p in both])  # type: ignore[misc]
    fc_m = compute_metrics(_pairs(both))
    assert base_m and fc_m
    baseline = schemas.Baseline(
        name="Same hour, last known day",
        description=(
            "Predict each hour with the output of the same hour on the most recent day already complete "
            "at the cutoff. The forecast has to beat this to be worth paying for."
        ),
        metrics=base_m,
        skill_vs_baseline_pct=100 * (base_m.mae_mw - fc_m.mae_mw) / base_m.mae_mw,
    )

    by_day = [_group_metrics(d.isoformat(), [p for p in pts if p.actual is not None]) for d, pts in days.items()
              if any(p.actual is not None for p in pts)]
    by_hour_buckets: dict[int, list[Point]] = defaultdict(list)
    for p in scored:
        by_hour_buckets[p.target.hour].append(p)
    by_hour = [_group_metrics(f"{h:02d}:00", by_hour_buckets[h]) for h in sorted(by_hour_buckets)]

    errors = [p.error for p in scored if p.error is not None]
    lo = math.floor(min(errors) / HISTOGRAM_BIN_MW) * HISTOGRAM_BIN_MW
    hi = math.ceil((max(errors) + 1e-9) / HISTOGRAM_BIN_MW) * HISTOGRAM_BIN_MW
    counts = [0] * ((hi - lo) // HISTOGRAM_BIN_MW)
    for e in errors:
        counts[min(int((e - lo) // HISTOGRAM_BIN_MW), len(counts) - 1)] += 1
    histogram = [
        schemas.HistogramBin(from_mw=lo + i * HISTOGRAM_BIN_MW, to_mw=lo + (i + 1) * HISTOGRAM_BIN_MW, count=c)
        for i, c in enumerate(counts)
    ]

    return schemas.AccuracyResponse(
        cutoff_utc=cutoff.strftime("%H:%M"),
        overall=overall,
        baseline=baseline,
        band=band,
        bias_correction=bias_correction(days),
        by_delivery_day=by_day,
        by_hour_of_day=by_hour,
        error_histogram=histogram,
    )


def horizon_view(ds: Dataset, bucket_h: int) -> schemas.HorizonResponse:
    """Error against how far ahead the forecast was made, over *every* January publication.

    Unlike the decision backtest (one forecast per hour, chosen by the cutoff), this scores all
    forecasts, so it shows how accuracy changes as the target gets closer.
    """
    errors_by_bucket: dict[int, list[float]] = defaultdict(list)
    for target, history in ds.forecasts_by_target.items():
        actual = ds.hourly_actual(target)
        if actual is None:
            continue
        for published, forecast in history:
            horizon_h = (target - published).total_seconds() / 3600
            errors_by_bucket[int(horizon_h // bucket_h)].append(forecast - actual)

    buckets = []
    for b in sorted(errors_by_bucket):
        errs = errors_by_bucket[b]
        buckets.append(
            schemas.HorizonBucket(
                from_h=b * bucket_h,
                to_h=(b + 1) * bucket_h,
                n=len(errs),
                mae_mw=sum(abs(e) for e in errs) / len(errs),
                rmse_mw=math.sqrt(sum(e * e for e in errs) / len(errs)),
                bias_mw=sum(errs) / len(errs),
            )
        )
    return schemas.HorizonResponse(bucket_h=bucket_h, buckets=buckets)
