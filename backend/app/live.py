"""The "Live now" view: today's Elexon forecast and wind output, plus weather from Open-Meteo.

This is a supplement to the January-2026 analysis, not part of it. Nothing here feeds the accuracy
numbers. Each source can fail on its own: the response then carries an error message for that source
and everything else is still returned.
"""

from __future__ import annotations

import asyncio
import time as _time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, TypeVar

import httpx

from . import schemas
from .elexon import BASE_URL as ELEXON_URL

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_TTL_S = 300
HISTORY_H = 36  # hours of recent actuals and weather to show
FUTURE_H = 48  # hours of forecast and weather to show


@dataclass(frozen=True)
class Site:
    name: str
    latitude: float
    longitude: float


# Rough centres of the main GB wind-farm areas. An unweighted mean is a crude indicator, not a
# capacity-weighted model: it says "is it windy where the turbines are", nothing more.
SITES = [
    Site("Hornsea, North Sea (offshore)", 53.9, 1.8),
    Site("Greater Gabbard, East Anglia (offshore)", 51.9, 1.9),
    Site("Walney, Irish Sea (offshore)", 54.05, -3.52),
    Site("Moray Firth (offshore)", 58.1, -2.9),
    Site("Whitelee, Scotland (onshore)", 55.68, -4.27),
    Site("Pen y Cymoedd, Wales (onshore)", 51.65, -3.65),
]

T = TypeVar("T")
_cache: dict[str, tuple[float, Any]] = {}


def clear_cache() -> None:
    _cache.clear()


async def _cached(key: str, loader: Callable[[], Awaitable[T]]) -> T:
    hit = _cache.get(key)
    if hit and _time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    value = await loader()
    _cache[key] = (_time.monotonic(), value)
    return value


def _parse(value: str) -> datetime:
    """Parses Elexon's 2026-10-25T04:30:00Z and Open-Meteo's zone-less 2026-10-25T04:45 (requested in UTC)."""
    if len(value) == 16:
        value += ":00Z"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _floor_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0)


# ---------------------------------------------------------------------------------------- Elexon


@dataclass(frozen=True)
class ElexonLive:
    published: datetime | None
    forecast: list[tuple[datetime, float]]  # (hour start, MW), from the latest release only
    actuals: list[tuple[datetime, float]]  # (half-hour start, MW)


async def _fetch_elexon(client: httpx.AsyncClient, now: datetime) -> ElexonLive:
    async def get(path: str, params: dict[str, str]) -> list[dict]:
        resp = await client.get(f"{ELEXON_URL}/{path}", params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    # Releases come every 2 to 4 hours, so the last 12 hours always contain the latest one.
    releases, outturn = await asyncio.gather(
        get("WINDFOR/stream", {"publishDateTimeFrom": _iso_z(now - timedelta(hours=12)), "publishDateTimeTo": _iso_z(now)}),
        get(
            "FUELHH/stream",
            {
                "settlementDateFrom": (now - timedelta(days=2)).date().isoformat(),
                "settlementDateTo": now.date().isoformat(),
                "fuelType": "WIND",
            },
        ),
    )

    published = max((_parse(r["publishTime"]) for r in releases), default=None)
    first_hour = _floor_hour(now)
    forecast = sorted(
        (_parse(r["startTime"]), float(r["generation"]))
        for r in releases
        if published and _parse(r["publishTime"]) == published and first_hour <= _parse(r["startTime"]) <= now + timedelta(hours=FUTURE_H)
    )
    actuals = sorted(
        (_parse(r["startTime"]), float(r["generation"]))
        for r in outturn
        if now - timedelta(hours=HISTORY_H) <= _parse(r["startTime"]) <= now
    )
    return ElexonLive(published, forecast, actuals)


# ------------------------------------------------------------------------------------- Open-Meteo


@dataclass(frozen=True)
class WeatherLive:
    observed_at: datetime | None
    sites: list[schemas.WeatherSite]
    index: list[schemas.WeatherIndexPoint]


async def _fetch_weather(client: httpx.AsyncClient) -> WeatherLive:
    resp = await client.get(
        OPEN_METEO_URL,
        params={
            "latitude": ",".join(str(s.latitude) for s in SITES),
            "longitude": ",".join(str(s.longitude) for s in SITES),
            "current": "wind_speed_100m,wind_direction_100m,wind_gusts_10m",
            "hourly": "wind_speed_100m",
            "wind_speed_unit": "ms",
            "timezone": "UTC",
            "past_hours": HISTORY_H,
            "forecast_hours": FUTURE_H,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    locations = body if isinstance(body, list) else [body]
    if len(locations) != len(SITES):
        raise ValueError(f"expected {len(SITES)} locations from Open-Meteo, got {len(locations)}")

    sites = []
    by_time: dict[datetime, list[float]] = {}
    observed: datetime | None = None
    for site, loc in zip(SITES, locations):
        current = loc.get("current") or {}
        if current.get("time"):
            observed = _parse(current["time"])
        direction = current.get("wind_direction_100m")
        sites.append(
            schemas.WeatherSite(
                name=site.name,
                latitude=site.latitude,
                longitude=site.longitude,
                wind_speed_100m_ms=current.get("wind_speed_100m"),
                gust_10m_ms=current.get("wind_gusts_10m"),
                direction_deg=None if direction is None else int(direction),
            )
        )
        hourly = loc.get("hourly") or {}
        for stamp, speed in zip(hourly.get("time", []), hourly.get("wind_speed_100m", [])):
            if speed is not None:
                by_time.setdefault(_parse(stamp), []).append(float(speed))

    index = [
        schemas.WeatherIndexPoint(time=t, wind_speed_100m_ms=sum(v) / len(v))
        for t, v in sorted(by_time.items())
        if len(v) == len(SITES)  # only hours where every site reported, so the mean is comparable
    ]
    return WeatherLive(observed, sites, index)


# --------------------------------------------------------------------------------------- the view


async def build_live(
    client: httpx.AsyncClient,
    now: datetime,
    band: schemas.BandInfo | None,
) -> schemas.LiveResponse:
    elexon_result, weather_result = await asyncio.gather(
        _guard(_cached("elexon", lambda: _fetch_elexon(client, now))),
        _guard(_cached("weather", lambda: _fetch_weather(client))),
    )
    errors: dict[str, str] = {}

    forecast: list[schemas.LiveForecastPoint] = []
    actuals: list[schemas.LiveActualPoint] = []
    published = None
    if isinstance(elexon_result, Exception):
        errors["elexon"] = _describe(elexon_result)
    else:
        published = elexon_result.published
        forecast = [
            schemas.LiveForecastPoint(
                target=t,
                forecast_mw=mw,
                low_mw=None if band is None else mw - band.error_p90_mw,
                high_mw=None if band is None else mw - band.error_p10_mw,
            )
            for t, mw in elexon_result.forecast
        ]
        actuals = [schemas.LiveActualPoint(start=t, generation_mw=mw) for t, mw in elexon_result.actuals]

    weather = None
    if isinstance(weather_result, Exception):
        errors["weather"] = _describe(weather_result)
    else:
        weather = schemas.LiveWeather(
            observed_at=weather_result.observed_at,
            sites=weather_result.sites,
            index=weather_result.index,
            source="Open-Meteo.com (CC BY 4.0)",
        )

    return schemas.LiveResponse(
        as_of=now, forecast_published=published, forecast=forecast, actuals=actuals, weather=weather, band=band, errors=errors
    )


async def _guard(awaitable: Awaitable[T]) -> T | Exception:
    try:
        return await awaitable
    except Exception as exc:  # noqa: BLE001 - one failing source must not take the other down
        return exc


def _describe(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"the service answered {exc.response.status_code}"
    if isinstance(exc, httpx.TimeoutException):
        return "the service did not answer in time"
    if isinstance(exc, httpx.HTTPError):
        return "the service could not be reached"
    return "the service returned data in an unexpected shape"
