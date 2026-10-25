from datetime import date, datetime, time, timedelta, timezone

import pytest

from app import analytics
from app.store import Dataset

UTC = timezone.utc


def at(day: int, hour: int = 0, minute: int = 0) -> datetime:
    """A January 2026 timestamp."""
    return datetime(2026, 1, day, hour, minute, tzinfo=UTC)


def make_dataset(forecasts: list[tuple[datetime, datetime, float]], actual_for_hour) -> Dataset:
    """forecasts: (published, target, MW). actual_for_hour(target) -> MW, applied to both half-hours."""
    by_target: dict[datetime, list[tuple[datetime, float]]] = {}
    for published, target, mw in forecasts:
        by_target.setdefault(target, []).append((published, mw))
    for history in by_target.values():
        history.sort()
    actuals = {}
    for target in {t for _, t, _ in forecasts} | {at(d, h) for d in range(1, 8) for h in range(24)}:
        for half in (0, 30):
            actuals[target + timedelta(minutes=half)] = actual_for_hour(target)
    return Dataset(
        actuals=actuals,
        forecasts_by_target=by_target,
        publish_times=sorted({p for p, _, _ in forecasts}),
        fetched_at=None,
    )


def test_percentile_interpolates_like_numpy():
    values = [1.0, 2.0, 3.0, 4.0]
    assert analytics.percentile(values, 0) == 1.0
    assert analytics.percentile(values, 1) == 4.0
    assert analytics.percentile(values, 0.5) == pytest.approx(2.5)
    assert analytics.percentile(values, 0.9) == pytest.approx(3.7)


def test_metrics_on_known_pairs():
    m = analytics.compute_metrics([(110.0, 100.0), (90.0, 100.0), (130.0, 100.0)])
    assert m is not None
    assert m.n == 3
    assert m.bias_mw == pytest.approx(10.0)  # (+10 -10 +30) / 3
    assert m.mae_mw == pytest.approx(50 / 3)
    assert m.rmse_mw == pytest.approx(((100 + 100 + 900) / 3) ** 0.5)
    assert m.mape_pct == pytest.approx(100 * (0.1 + 0.1 + 0.3) / 3)
    assert m.max_abs_error_mw == 30.0
    assert analytics.compute_metrics([]) is None


def test_decision_uses_only_forecasts_published_before_the_cutoff():
    target = at(5, 12)
    before, after = at(4, 7, 30), at(4, 9, 30)
    ds = make_dataset([(before, target, 1000.0), (after, target, 2000.0)], lambda t: 1500.0)

    pts = analytics.build_points(ds, date(2026, 1, 5), time(9, 0))
    (p,) = [p for p in pts if p.target == target]
    assert p.forecast == 1000.0  # the 09:30 publication did not exist yet at 09:00
    assert p.published == before

    later = analytics.build_points(ds, date(2026, 1, 5), time(10, 0))
    (p2,) = [p for p in later if p.target == target]
    assert p2.forecast == 2000.0
    assert p2.previous_forecast == 1000.0


def test_no_forecast_before_first_publication_means_no_point():
    ds = make_dataset([(at(4, 7, 30), at(5, 12), 1000.0)], lambda t: 1500.0)
    assert analytics.build_points(ds, date(2026, 1, 5), time(6, 0)) == []


def test_persistence_baseline_uses_last_complete_day():
    # Actual output equals the day of the month, so we can see which day was picked.
    ds = make_dataset([(at(3, 2, 30), at(6, 15), 1.0)], lambda t: float(t.day))
    as_of_9 = analytics.decision_time(date(2026, 1, 6), time(9, 0))  # 5 Jan 09:00
    # 15:00 on 5 Jan is not over yet at 09:00, so the baseline falls back to 4 Jan 15:00.
    assert analytics._persistence(ds, at(6, 15), as_of_9) == 4.0
    # 05:00 on 5 Jan is already complete at 09:00.
    assert analytics._persistence(ds, at(6, 5), as_of_9) == 5.0


def _days_with_constant_error(errors_by_day: dict[int, float]) -> dict[date, list[analytics.Point]]:
    days = {}
    for d, err in errors_by_day.items():
        target = at(d, 12)
        days[date(2026, 1, d)] = [
            analytics.Point(target, 1000.0 + err, target - timedelta(hours=20), 20.0, None, 1000.0, None)
        ]
    return days


def test_bias_correction_is_walk_forward():
    # Delivery day 7's shift may only use days <= 5. A huge error on day 6 must not leak into it.
    days = _days_with_constant_error({2: 100.0, 3: 100.0, 4: 100.0, 5: 100.0, 6: 9000.0, 7: 100.0})
    result = analytics.bias_correction(days)
    assert result is not None
    # Evaluated days: 6 (history 2-4) and 7 (history 2-5). Day 7 is corrected perfectly; day 6 is not.
    assert result.n_days_evaluated == 2
    assert result.mae_adjusted_mw == pytest.approx((8900 + 0) / 2)
    assert result.mae_raw_mw == pytest.approx((9000 + 100) / 2)


def test_bias_correction_needs_history():
    assert analytics.bias_correction(_days_with_constant_error({2: 1.0, 3: 1.0})) is None


def test_error_band_leave_one_day_out_is_not_in_sample():
    # One day with errors far outside everyone else's range cannot be covered when it is left out.
    days = _days_with_constant_error({d: 100.0 + d for d in range(2, 12)})
    days.update(_days_with_constant_error({20: 5000.0}))
    band = analytics.error_band(days)
    assert band is not None
    assert band.leave_one_day_out_coverage < band.in_sample_coverage
    assert band.n_days == 11
