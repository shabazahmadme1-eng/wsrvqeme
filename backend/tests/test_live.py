"""The live view, with both external services replaced by canned responses (no network)."""

import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import live
from app.main import app, http_client

NOW = datetime(2026, 10, 25, 4, 50, tzinfo=timezone.utc)


def windfor_rows():
    rows = []
    for publish, base in (("2026-10-25T02:30:00Z", 9000), ("2026-10-25T04:30:00Z", 10000)):
        for i, hour in enumerate(range(2, 8)):  # targets 02:00 .. 07:00
            rows.append({"publishTime": publish, "startTime": f"2026-10-25T{hour:02d}:00:00Z", "generation": base + i * 100})
    return rows


def fuelhh_rows():
    return [
        {"startTime": "2026-10-25T03:30:00Z", "generation": 10500, "fuelType": "WIND"},
        {"startTime": "2026-10-25T04:00:00Z", "generation": 10795, "fuelType": "WIND"},
        {"startTime": "2026-10-25T05:00:00Z", "generation": 99999, "fuelType": "WIND"},  # in the future: must be ignored
        {"startTime": "2026-10-20T00:00:00Z", "generation": 1, "fuelType": "WIND"},  # older than the window
    ]


def open_meteo_payload():
    def location(speed):
        return {
            "current": {"time": "2026-10-25T04:45", "wind_speed_100m": speed, "wind_direction_100m": 243, "wind_gusts_10m": speed + 3},
            "hourly": {"time": ["2026-10-25T04:00", "2026-10-25T05:00"], "wind_speed_100m": [speed, speed + 2]},
        }

    return [location(10.0 + i) for i in range(len(live.SITES))]


class Upstream:
    def __init__(self, weather_status=200, elexon_status=200):
        self.calls = {"elexon": 0, "weather": 0}
        self.weather_status, self.elexon_status = weather_status, elexon_status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if "open-meteo" in request.url.host:
            self.calls["weather"] += 1
            return httpx.Response(self.weather_status, json=open_meteo_payload())
        self.calls["elexon"] += 1
        if self.elexon_status != 200:
            return httpx.Response(self.elexon_status, json={})
        body = windfor_rows() if "WINDFOR" in request.url.path else fuelhh_rows()
        return httpx.Response(200, content=json.dumps(body))


@pytest.fixture(autouse=True)
def fresh_cache():
    live.clear_cache()


async def run(upstream, band=None):
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        return await live.build_live(client, NOW, band)


async def test_uses_only_the_latest_release_and_future_hours():
    result = await run(Upstream())
    assert result.errors == {}
    assert result.forecast_published == datetime(2026, 10, 25, 4, 30, tzinfo=timezone.utc)
    # latest release only, starting from the current hour (04:00), not the earlier 02:30 release or earlier hours
    assert [p.target.hour for p in result.forecast] == [4, 5, 6, 7]
    assert result.forecast[0].forecast_mw == 10200  # 04:00 of the 04:30 release: base 10000 + index 2 * 100


async def test_actuals_are_windowed_to_the_past():
    result = await run(Upstream())
    assert [a.generation_mw for a in result.actuals] == [10500, 10795]


async def test_weather_index_is_the_mean_across_sites():
    result = await run(Upstream())
    assert result.weather is not None
    speeds = [10.0 + i for i in range(len(live.SITES))]
    assert result.weather.index[0].wind_speed_100m_ms == pytest.approx(sum(speeds) / len(speeds))
    assert result.weather.index[1].wind_speed_100m_ms == pytest.approx(sum(speeds) / len(speeds) + 2)
    assert result.weather.observed_at == datetime(2026, 10, 25, 4, 45, tzinfo=timezone.utc)
    assert result.weather.sites[0].direction_deg == 243


async def test_one_failing_source_does_not_take_down_the_other():
    result = await run(Upstream(weather_status=503))
    assert result.weather is None
    assert "weather" in result.errors and "503" in result.errors["weather"]
    assert len(result.forecast) == 4  # Elexon half is intact

    live.clear_cache()
    result = await run(Upstream(elexon_status=500))
    assert result.forecast == [] and "elexon" in result.errors
    assert result.weather is not None


async def test_results_are_cached_between_requests():
    upstream = Upstream()
    await run(upstream)
    await run(upstream)
    assert upstream.calls == {"elexon": 2, "weather": 1}  # two Elexon endpoints per refresh, weather once


def test_live_endpoint_shape_and_band():
    upstream = Upstream()

    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            yield client

    app.dependency_overrides[http_client] = override
    try:
        body = TestClient(app).get("/api/live").json()
    finally:
        app.dependency_overrides.clear()
    assert body["band"]["n_days"] == 31
    point = body["forecast"][0]
    assert point["low_mw"] < point["high_mw"]
    assert set(body["errors"]) <= {"elexon", "weather"}
