"""Contract tests against the real January snapshot in backend/data."""

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import analytics
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
    assert len(body["points"]) + len(body["missing_hours"]) == 24
    for p in body["points"]:
        assert datetime.fromisoformat(p["published"]) <= decided_at
        assert p["horizon_h"] > 0
        assert p["target"][:10] == delivery
    # The band may only use delivery days that had finished by the decision time.
    if body["band"] is not None:
        assert date.fromisoformat(body["band"]["history_to"]) <= date.fromisoformat(delivery) - timedelta(days=2)


def test_band_is_withheld_until_three_days_have_finished():
    assert client.get("/api/decision", params={"delivery_date": "2026-01-05"}).json()["band"] is None
    band = client.get("/api/decision", params={"delivery_date": "2026-01-06"}).json()["band"]
    assert band["history_days"] == 3 and band["history_to"] == "2026-01-04"


def test_likely_range_never_goes_below_zero():
    for delivery in analytics.delivery_dates():
        for p in client.get("/api/decision", params={"delivery_date": delivery.isoformat()}).json()["points"]:
            if p["low_mw"] is not None:
                assert 0 <= p["low_mw"] <= p["high_mw"]


def test_early_cutoff_reports_the_hours_no_release_reached():
    # Before the first release of D-1 (02:30), the newest release in hand stops at 21:00 on D.
    body = client.get("/api/decision", params={"delivery_date": "2026-01-03", "cutoff": "01:00"}).json()
    assert [h[11:16] for h in body["missing_hours"]] == ["22:00", "23:00"]
    assert body["summary"]["hours"] == 22


def test_first_day_uses_the_releases_of_31_december():
    # A decision at 02:00 on 1 Jan predates that day's first release, so it relies on 31 Dec's last one.
    resp = client.get("/api/decision", params={"delivery_date": "2026-01-02", "cutoff": "02:00"})
    assert resp.status_code == 200
    assert {p["published"] for p in resp.json()["points"]} == {"2025-12-31T22:30:00Z"}


def test_decision_rejects_dates_outside_january_decisions():
    assert client.get("/api/decision", params={"delivery_date": "2026-01-01"}).status_code == 422
    assert client.get("/api/decision", params={"delivery_date": "2026-02-02"}).status_code == 422


def test_decision_rejects_bad_cutoff():
    assert client.get("/api/decision", params={"delivery_date": "2026-01-10", "cutoff": "9am"}).status_code == 422
    assert client.get("/api/decision", params={"delivery_date": "2026-01-10", "cutoff": "24:00"}).status_code == 422


def test_accuracy_is_internally_consistent():
    body = client.get("/api/accuracy").json()
    overall = body["overall"]
    assert overall["n"] == sum(g["n"] for g in body["by_delivery_day"])
    assert overall["n"] == sum(g["n"] for g in body["by_hour_of_day"])
    assert overall["n"] == sum(b["count"] for b in body["error_histogram"])
    assert overall["mae_mw"] <= overall["rmse_mw"]
    assert overall["p50_abs_error_mw"] <= overall["p90_abs_error_mw"] <= overall["max_abs_error_mw"]
    assert body["baseline"]["metrics"]["mae_mw"] > overall["mae_mw"]  # forecast beats naive persistence
    assert body["baseline"]["metrics"]["n"] == overall["n"]  # the baseline exists for every scored hour
    assert 0.5 < body["band"]["leave_one_day_out_coverage"] < 1.0
    assert 0.5 < body["band"]["walk_forward_coverage"] < 1.0
    assert len(body["by_delivery_day"]) == 31


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


def test_publications_on_the_first_day_point_back_to_31_december():
    body = client.get("/api/publications", params={"delivery_date": "2026-01-02"}).json()
    assert body["previous_release"] == "2025-12-31T22:30:00Z"
