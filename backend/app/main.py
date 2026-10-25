"""FastAPI app: JSON API under /api, and (when a build exists) the React app served from /."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import analytics, live, schemas
from .store import load_dataset

CUTOFF_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"
CutoffParam = Query(
    analytics.DEFAULT_CUTOFF.strftime("%H:%M"),
    pattern=CUTOFF_PATTERN,
    description="HH:MM (UTC; equals UK time in January) by which the day-ahead purchase must be decided on the previous day",
)

# Day D sees finished days up to D-2, so the first band needs FIRST_DELIVERY + MIN_HISTORY_DAYS + 1.
_FIRST_BAND = analytics.FIRST_DELIVERY + timedelta(days=analytics.MIN_HISTORY_DAYS + 1)

NOTES = [
    "All times are UTC. January is GMT, so UTC equals UK local time.",
    "Forecasts come from Elexon WINDFOR and actuals from FUELHH (fuelType WIND), national level only.",
    "A purchase decision made on day D-1 at the cutoff may only use forecasts published at or before that time.",
    "Forecasts are hourly; actuals are half-hourly. Each forecast hour is compared with the mean of its two half-hours.",
    "Error = forecast - actual. Positive error means the wind forecast was higher than what was generated.",
    "On the buying page the likely range and the bias come only from delivery days already finished at the decision "
    f"time, so they appear from {_FIRST_BAND.day} {_FIRST_BAND:%B}. The accuracy page looks back over the whole month.",
    "Decisions taken on 1 January before that day's first release (02:30) use the releases of 31 December.",
]


def _time(value: str) -> time:
    return time.fromisoformat(value)


def _check_delivery_date(delivery_date: date) -> None:
    if not analytics.FIRST_DELIVERY <= delivery_date <= analytics.LAST_DELIVERY:
        raise HTTPException(
            422,
            f"delivery_date must be between {analytics.FIRST_DELIVERY} and {analytics.LAST_DELIVERY} "
            "(decisions made in January 2026 are for delivery the following day)",
        )


router = APIRouter(prefix="/api")


async def http_client() -> AsyncIterator[httpx.AsyncClient]:
    """One short-lived client per request: safe on serverless hosts where event loops are not shared."""
    async with httpx.AsyncClient(headers={"User-Agent": "wind-day-ahead-desk"}) as client:
        yield client


def current_time() -> datetime:
    """The clock, as a dependency so tests can pin it."""
    return datetime.now(timezone.utc)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/meta", response_model=schemas.Meta)
def meta() -> schemas.Meta:
    ds = load_dataset()
    last_actual = max(ds.actuals)
    return schemas.Meta(
        coverage=schemas.Coverage(
            decisions_from=analytics.DECISION_FROM,
            decisions_to=analytics.DECISION_TO,
            delivery_from=analytics.FIRST_DELIVERY,
            delivery_to=analytics.LAST_DELIVERY,
            actuals_to=last_actual,
        ),
        publish_times_utc=sorted({p.strftime("%H:%M") for p in ds.publish_times}),
        default_cutoff=analytics.DEFAULT_CUTOFF.strftime("%H:%M"),
        data_fetched_at=ds.fetched_at,
        n_forecast_rows=sum(len(h) for h in ds.forecasts_by_target.values()),
        n_actual_half_hours=len(ds.actuals),
        notes=NOTES,
    )


@router.get("/decision", response_model=schemas.DecisionResponse)
def decision(delivery_date: date, cutoff: str = CutoffParam) -> schemas.DecisionResponse:
    """The forecast a buyer could see when deciding the day-ahead purchase for `delivery_date`."""
    _check_delivery_date(delivery_date)
    result = analytics.decision_view(load_dataset(), delivery_date, _time(cutoff))
    if result is None:
        raise HTTPException(404, f"No forecast was available at {cutoff} on the day before {delivery_date}")
    return result


@router.get("/publications", response_model=schemas.PublicationsResponse)
def publications(delivery_date: date) -> schemas.PublicationsResponse:
    """When forecasts were released on the day before `delivery_date`. Drives the cutoff timeline in the UI."""
    _check_delivery_date(delivery_date)
    decision_day = delivery_date - timedelta(days=1)
    releases = load_dataset().publish_times
    earlier = [p for p in releases if p.date() < decision_day]
    return schemas.PublicationsResponse(
        delivery_date=delivery_date,
        decision_day=decision_day,
        publications=[p for p in releases if p.date() == decision_day],
        previous_release=earlier[-1] if earlier else None,
    )


@router.get("/live", response_model=schemas.LiveResponse)
async def live_now(
    client: httpx.AsyncClient = Depends(http_client), now: datetime = Depends(current_time)
) -> schemas.LiveResponse:
    """Today's Elexon forecast and wind output, plus weather. Outside the January analysis; see app/live.py."""
    band = analytics.band_for_cutoff(load_dataset(), analytics.DEFAULT_CUTOFF)  # cached after the first call
    return await live.build_live(client, now, band)


@router.get("/accuracy", response_model=schemas.AccuracyResponse)
def accuracy(cutoff: str = CutoffParam) -> schemas.AccuracyResponse:
    """How good the decision-time forecast was across every January decision."""
    result = analytics.accuracy_view(load_dataset(), _time(cutoff))
    if result is None:
        raise HTTPException(404, f"Not enough scored decisions at cutoff {cutoff}")
    return result


@router.get("/accuracy/horizon", response_model=schemas.HorizonResponse)
def accuracy_by_horizon(bucket_h: int = Query(6, ge=1, le=24)) -> schemas.HorizonResponse:
    """Error against forecast lead time, over all published forecasts."""
    return analytics.horizon_view(load_dataset(), bucket_h)


app = FastAPI(
    title="Wind Day-Ahead Desk API",
    description="Latest GB wind forecasts for day-ahead buying decisions, and how accurate they have been.",
    version="1.0.0",
)
app.include_router(router)

# In the Docker image the React build is copied next to the backend and served from the same origin.
_static = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if _static.is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="frontend")
