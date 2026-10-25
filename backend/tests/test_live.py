"""The live view, with both external services replaced by canned responses (no network)."""

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import live, schemas
from app.main import app, current_time, http_client

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
        if "FUELHH" in request.url.path:
            self.fuelhh_params = dict(request.url.params)
        body = windfor_rows() if "WINDFOR" in request.url.path else fuelhh_rows()
        return httpx.Response(200, content=json.dumps(body))


@pytest.fixture(autouse=True)
def fresh_cache():
    live.clear_cache()


async def run(upstream, band=None, now=NOW):
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        return await live.build_live(client, now, band)


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


async def test_cached_data_reports_when_it_was_fetched():
    upstream = Upstream()
    await run(upstream)
    later = await run(upstream, now=NOW + timedelta(minutes=3))
    assert later.as_of == NOW  # served from cache, so it must not claim to be 3 minutes fresher


async def test_now_check_uses_the_forecast_made_before_the_hour():
    result = await run(Upstream())
    check = result.now_check
    assert check is not None
    # Latest metered half-hour starts 04:00. The 04:30 release was published inside that hour, so the
    # comparison uses the 02:30 release: base 9000 + index 2 * 100 for the 04:00 target.
    assert check.hour == datetime(2026, 10, 25, 4, tzinfo=timezone.utc)
    assert check.published == datetime(2026, 10, 25, 2, 30, tzinfo=timezone.utc)
    assert (check.forecast_mw, check.actual_mw) == (9200, 10795)


async def test_outturn_query_reaches_the_next_uk_settlement_date():
    upstream = Upstream()
    await run(upstream)
    assert upstream.fuelhh_params["settlementDateTo"] == "2026-10-26"


async def test_likely_range_is_floored_at_zero():
    band = schemas.BandInfo(
        level=0.8, error_p10_mw=-500, error_p90_mw=50_000, in_sample_coverage=0.8,
        leave_one_day_out_coverage=0.8, walk_forward_coverage=0.8, walk_forward_days=1, n_days=2,
    )
    result = await run(Upstream(), band=band)
    assert all(p.low_mw == 0 for p in result.forecast)


def test_live_endpoint_shape_and_band():
    upstream = Upstream()

    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            yield client

    # Pin the clock to the canned data, so the test does not depend on when it runs.
    app.dependency_overrides[http_client] = override
    app.dependency_overrides[current_time] = lambda: NOW
    try:
        body = TestClient(app).get("/api/live").json()
    finally:
        app.dependency_overrides.clear()
    assert body["band"]["n_days"] == 31
    assert len(body["forecast"]) == 4
    point = body["forecast"][0]
    assert 0 <= point["low_mw"] < point["high_mw"]
    assert body["now_check"]["forecast_mw"] == 9200
    assert body["errors"] == {}
