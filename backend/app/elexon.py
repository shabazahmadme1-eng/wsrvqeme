"""Thin client for the two Elexon BMRS datasets this app needs.

Both endpoints are public (no API key). We call the `/stream` variants, which return a plain JSON
array and accept a date window, and we request one day at a time to keep each response small.
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone

import httpx

BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1/datasets"
TIMEOUT_S = 60
RETRIES = 4


def _get_json(client: httpx.Client, path: str, params: dict) -> list[dict]:
    last_error: Exception | None = None
    for attempt in range(RETRIES):
        try:
            resp = client.get(f"{BASE_URL}/{path}", params=params, timeout=TIMEOUT_S)
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError) as exc:  # network error, 4xx/5xx, bad JSON
            last_error = exc
            time.sleep(2**attempt)
    raise RuntimeError(f"Elexon request failed after {RETRIES} attempts: {path} {params}") from last_error


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_actuals(client: httpx.Client, start: date, end: date) -> list[dict]:
    """FUELHH half-hourly outturn, wind only. `start`/`end` are inclusive settlement dates."""
    rows: list[dict] = []
    day = start
    while day <= end:
        rows += _get_json(
            client,
            "FUELHH/stream",
            {"settlementDateFrom": day.isoformat(), "settlementDateTo": day.isoformat(), "fuelType": "WIND"},
        )
        day += timedelta(days=1)
    return rows


def fetch_forecasts(client: httpx.Client, publish_from: datetime, publish_to: datetime) -> list[dict]:
    """WINDFOR forecasts published in [publish_from, publish_to), fetched one UTC day at a time."""
    rows: list[dict] = []
    cursor = publish_from
    while cursor < publish_to:
        nxt = min(cursor + timedelta(days=1), publish_to)
        rows += _get_json(
            client,
            "WINDFOR/stream",
            {"publishDateTimeFrom": _iso_z(cursor), "publishDateTimeTo": _iso_z(nxt)},
        )
        cursor = nxt
    return rows
