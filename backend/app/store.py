"""Loads the CSV snapshot into memory and answers "what did we know at time T?" queries.

The whole dataset is ~20k rows, so plain dicts and `bisect` are plenty: no database, no pandas.
"""

from __future__ import annotations

import csv
from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def parse_utc(value: str) -> datetime:
    """Elexon timestamps look like 2026-01-05T11:30:00Z."""
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


@dataclass(frozen=True)
class Dataset:
    # Half-hourly metered wind output (MW), keyed by the start of the settlement period.
    actuals: dict[datetime, float]
    # target hour -> [(publish time, forecast MW)] sorted by publish time (oldest first).
    forecasts_by_target: dict[datetime, list[tuple[datetime, float]]]
    publish_times: list[datetime]
    fetched_at: str | None

    def hourly_actual(self, hour_start: datetime) -> float | None:
        """Mean of the two half-hours that make up the hour (forecasts are hourly averages).

        Returns None unless both half-hours are present, so we never compare against a partial hour.
        """
        a = self.actuals.get(hour_start)
        b = self.actuals.get(hour_start + timedelta(minutes=30))
        if a is None or b is None:
            return None
        return (a + b) / 2

    def forecasts_as_of(self, target: datetime, as_of: datetime) -> list[tuple[datetime, float]]:
        """All forecasts for `target` that had been published by `as_of`, oldest first."""
        history = self.forecasts_by_target.get(target, [])
        return history[: bisect_right(history, as_of, key=lambda item: item[0])]

    def latest_forecast(self, target: datetime, as_of: datetime) -> tuple[datetime, float] | None:
        known = self.forecasts_as_of(target, as_of)
        return known[-1] if known else None


def _read_csv(name: str) -> list[dict[str, str]]:
    with (DATA_DIR / name).open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


@lru_cache(maxsize=1)
def load_dataset() -> Dataset:
    actuals = {parse_utc(r["startTime"]): float(r["generation"]) for r in _read_csv("actuals.csv")}

    by_target: dict[datetime, list[tuple[datetime, float]]] = {}
    publish_times: set[datetime] = set()
    for r in _read_csv("forecasts.csv"):
        published, target = parse_utc(r["publishTime"]), parse_utc(r["startTime"])
        # Forecasts published at or after their own target hour are hindcasts, not forecasts: nobody
        # can act on them, so they never enter the dataset.
        if published >= target:
            continue
        by_target.setdefault(target, []).append((published, float(r["generation"])))
        publish_times.add(published)
    for history in by_target.values():
        history.sort()

    stamp = DATA_DIR / "FETCHED_AT.txt"
    return Dataset(
        actuals=actuals,
        forecasts_by_target=by_target,
        publish_times=sorted(publish_times),
        fetched_at=stamp.read_text().strip() if stamp.exists() else None,
    )
