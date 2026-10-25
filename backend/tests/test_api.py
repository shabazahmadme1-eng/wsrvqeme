"""Contract tests against the real January snapshot in backend/data."""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.store import load_dataset

client = TestClient(app)


def test_snapshot_has_no_hindcasts():
    ds = load_dataset()
    for target, history in ds.forecasts_by_target.items():
        assert all(published < target for published, _ in history)
        assert history == sorted(history)


def test_health_and_meta():
    assert client.get("/api/health").json() == {"status": "ok"}
    meta = client.get("/api/meta").json()
    assert meta["coverage"]["delivery_from"] == "2026-01-02"
    assert meta["coverage"]["delivery_to"] == "2026-02-01"
    assert meta["n_actual_half_hours"] > 1000


@pytest.mark.parametrize("delivery,cutoff", [("2026-01-02", "09:00"), ("2026-01-15", "09:00"), ("2026-02-01", "12:30")])
def test_decision_never_looks_ahead(delivery, cutoff):
    resp = client.get("/api/decision", params={"delivery_date": delivery, "cutoff": cutoff})
    assert resp.status_code == 200
    body = resp.json()
    decided_at = datetime.fromisoformat(body["decision_time"])
    assert len(body["points"]) == 24
    for p in body["points"]:
        assert datetime.fromisoformat(p["published"]) <= decided_at
        assert p["horizon_h"] > 0
        assert p["low_mw"] < p["high_mw"]
        assert p["target"][:10] == delivery


def test_decision_rejects_dates_outside_january_decisions():
    assert client.get("/api/decision", params={"delivery_date": "2026-01-01"}).status_code == 422
    assert client.get("/api/decision", params={"delivery_date": "2026-02-02"}).status_code == 422


def test_decision_rejects_bad_cutoff():
    assert client.get("/api/decision", params={"delivery_date": "2026-01-10", "cutoff": "9am"}).status_code == 422
    assert client.get("/api/decision", params={"delivery_date": "2026-01-10", "cutoff": "24:00"}).status_code == 422


def test_decision_before_any_forecast_exists_is_404():
    # The first January forecast is published at 02:30 on 1 Jan, so a 02:00 cutoff has nothing to show for 2 Jan.
    resp = client.get("/api/decision", params={"delivery_date": "2026-01-02", "cutoff": "02:00"})
    assert resp.status_code == 404


def test_accuracy_is_internally_consistent():
    body = client.get("/api/accuracy").json()
    overall = body["overall"]
    assert overall["n"] == sum(g["n"] for g in body["by_delivery_day"])
    assert overall["n"] == sum(g["n"] for g in body["by_hour_of_day"])
    assert overall["n"] == sum(b["count"] for b in body["error_histogram"])
    assert overall["mae_mw"] <= overall["rmse_mw"]
    assert overall["p50_abs_error_mw"] <= overall["p90_abs_error_mw"] <= overall["max_abs_error_mw"]
    assert body["baseline"]["metrics"]["mae_mw"] > overall["mae_mw"]  # forecast beats naive persistence
    assert 0.5 < body["band"]["leave_one_day_out_coverage"] < 1.0


def test_horizon_buckets():
    body = client.get("/api/accuracy/horizon", params={"bucket_h": 12}).json()
    assert body["bucket_h"] == 12
    froms = [b["from_h"] for b in body["buckets"]]
    assert froms == sorted(froms) and froms[0] == 0
    assert client.get("/api/accuracy/horizon", params={"bucket_h": 0}).status_code == 422


def test_publications_lists_the_decision_day_releases():
    body = client.get("/api/publications", params={"delivery_date": "2026-01-15"}).json()
    assert body["decision_day"] == "2026-01-14"
    assert len(body["publications"]) >= 6
    assert all(p.startswith("2026-01-14") for p in body["publications"])
    assert body["previous_release"].startswith("2026-01-13")
    assert client.get("/api/publications", params={"delivery_date": "2026-03-01"}).status_code == 422


def test_publications_has_no_previous_release_on_the_first_day():
    body = client.get("/api/publications", params={"delivery_date": "2026-01-02"}).json()
    assert body["previous_release"] is None
