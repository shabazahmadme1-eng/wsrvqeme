"""Download the January 2026 wind data from Elexon and write the CSV snapshot the API serves.

    python scripts/fetch_data.py

Window (all UTC; January is GMT so UTC == UK local time):
  * forecasts: published 2025-12-31 00:00 .. 2026-02-01 00:00. Decisions are taken in January, but one
    taken in the small hours of 1 January (before that day's first release at 02:30) relies on the
    releases of 31 December.
  * actuals: settlement dates 2025-12-30 .. 2026-02-04. The naive baseline for 2 January looks back to
    31 December, and a forecast published late on 31 January reaches 72 hours ahead (to 3 Feb).

The snapshot is committed to the repo so the deployed app never depends on Elexon being reachable.
"""

from __future__ import annotations

import csv
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import elexon  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

PUBLISH_FROM = datetime(2025, 12, 31, tzinfo=timezone.utc)
PUBLISH_TO = datetime(2026, 2, 1, tzinfo=timezone.utc)
ACTUALS_FROM = date(2025, 12, 30)
ACTUALS_TO = date(2026, 2, 4)


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with httpx.Client() as client:
        print("fetching WIND actuals (FUELHH)...")
        actuals = elexon.fetch_actuals(client, ACTUALS_FROM, ACTUALS_TO)
        print(f"  {len(actuals)} rows")
        print("fetching wind forecasts (WINDFOR)...")
        forecasts = elexon.fetch_forecasts(client, PUBLISH_FROM, PUBLISH_TO)
        print(f"  {len(forecasts)} rows")

    # De-duplicate on the natural key and sort so the snapshot is stable between runs.
    act = {r["startTime"]: r["generation"] for r in actuals if r.get("fuelType") == "WIND"}
    fc = {(r["publishTime"], r["startTime"]): r["generation"] for r in forecasts}

    write_csv(DATA_DIR / "actuals.csv", ["startTime", "generation"], [[k, v] for k, v in sorted(act.items())])
    write_csv(
        DATA_DIR / "forecasts.csv",
        ["publishTime", "startTime", "generation"],
        [[p, s, g] for (p, s), g in sorted(fc.items())],
    )
    (DATA_DIR / "FETCHED_AT.txt").write_text(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") + "\n")
    print(f"wrote {len(act)} actuals and {len(fc)} forecasts to {DATA_DIR}")


if __name__ == "__main__":
    main()
