from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "site" / "data" / "funding.json"
CHINA_TZ = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True, slots=True)
class FundingSeries:
    asset: str
    venue: str
    contract: str
    listing_start_ms: int
    provider: str


SERIES = (
    FundingSeries("CXMT", "Binance", "CXMTUSDT", 1_787_029_200_000, "binance"),
    FundingSeries("CXMT", "XYZ", "xyz:CXMT", 1_787_029_200_000, "hyperliquid"),
    FundingSeries("UNITREE", "Binance", "UNITREEUSDT", 1_787_107_500_000, "binance"),
    FundingSeries("UNITREE", "XYZ", "xyz:UNITREE", 1_787_107_500_000, "hyperliquid"),
    FundingSeries("UNITREE", "PARA", "para:UNITREE", 1_787_107_500_000, "hyperliquid"),
)


OFFICIAL_CLOSED_RANGES_2026 = (
    ("2026-01-01", "2026-01-04"),
    ("2026-02-14", "2026-02-23"),
    ("2026-02-28", "2026-02-28"),
    ("2026-04-04", "2026-04-06"),
    ("2026-05-01", "2026-05-05"),
    ("2026-05-09", "2026-05-09"),
    ("2026-06-19", "2026-06-21"),
    ("2026-09-20", "2026-09-20"),
    ("2026-09-25", "2026-09-27"),
    ("2026-10-01", "2026-10-07"),
    ("2026-10-10", "2026-10-10"),
)


def request_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    attempts: int = 3,
) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "User-Agent": "FundingLensSnapshot/1.0 (+GitHub Pages)",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(url, data=body, headers=headers, method="POST" if body else "GET")
            with urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"request failed after {attempts} attempts: {last_error}")


def fetch_binance(series: FundingSeries) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = series.listing_start_ms
    for _ in range(50):
        query = urlencode({"symbol": series.contract, "startTime": cursor, "limit": 1000})
        page = request_json(f"https://fapi.binance.com/fapi/v1/fundingRate?{query}")
        if not isinstance(page, list):
            raise ValueError("Binance returned a non-list payload")
        rows.extend(page)
        if not page or len(page) < 1000:
            break
        next_cursor = int(page[-1]["fundingTime"]) + 1
        if next_cursor <= cursor:
            break
        cursor = next_cursor
    return rows


def fetch_hyperliquid(series: FundingSeries) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = series.listing_start_ms
    end_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for _ in range(100):
        page = request_json(
            "https://api.hyperliquid.xyz/info",
            payload={
                "type": "fundingHistory",
                "coin": series.contract,
                "startTime": cursor,
                "endTime": end_ms,
            },
        )
        if not isinstance(page, list):
            raise ValueError("Hyperliquid returned a non-list payload")
        rows.extend(page)
        if not page or len(page) < 500:
            break
        next_cursor = int(page[-1]["time"]) + 1
        if next_cursor <= cursor:
            break
        cursor = next_cursor
    deduplicated = {
        (str(row.get("coin", series.contract)), int(row["time"])): row for row in rows
    }
    return sorted(deduplicated.values(), key=lambda row: int(row["time"]))


def classify_a_share_session(timestamp_ms: int) -> dict[str, Any]:
    value = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(CHINA_TZ)
    date_text = value.date().isoformat()
    minute = value.hour * 60 + value.minute
    if value.weekday() >= 5:
        return {"code": "WEEKEND", "label": "周末休市", "is_open": False}
    if any(start <= date_text <= end for start, end in OFFICIAL_CLOSED_RANGES_2026):
        return {"code": "HOLIDAY", "label": "官方休市日", "is_open": False}
    if 555 <= minute < 565:
        return {"code": "OPEN_AUCTION", "label": "开盘集合竞价", "is_open": True}
    if 570 <= minute < 690:
        return {"code": "CONTINUOUS_AM", "label": "上午连续竞价", "is_open": True}
    if 690 <= minute < 780:
        return {"code": "MIDDAY_BREAK", "label": "午间休市", "is_open": False}
    if 780 <= minute < 897:
        return {"code": "CONTINUOUS_PM", "label": "下午连续竞价", "is_open": True}
    if 897 <= minute < 900:
        return {"code": "CLOSE_AUCTION", "label": "收盘集合竞价", "is_open": True}
    return {"code": "OFF_HOURS", "label": "盘前/盘后休市", "is_open": False}


def iso_utc(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()


def normalize_row(series: FundingSeries, raw: dict[str, Any]) -> dict[str, Any]:
    timestamp_ms = int(raw.get("fundingTime", raw.get("time")))
    session = classify_a_share_session(timestamp_ms)
    return {
        "timestamp_ms": timestamp_ms,
        "timestamp": iso_utc(timestamp_ms),
        "asset": series.asset,
        "venue": series.venue,
        "contract": series.contract,
        "funding_rate": float(raw["fundingRate"]),
        "premium": None if raw.get("premium") is None else float(raw["premium"]),
        "mark_price": None if raw.get("markPrice") is None else float(raw["markPrice"]),
        "rate_type": raw.get("rateType"),
        "session": "OPEN" if session["is_open"] else "CLOSED",
        "market_state": session["code"],
        "market_state_label": session["label"],
    }


def metric_bucket() -> dict[str, float]:
    return {"total": 0.0, "open": 0.0, "closed": 0.0}


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = {"positive": metric_bucket(), "negative": metric_bucket(), "net": metric_bucket()}
    for row in rows:
        rate = row["funding_rate"]
        session_key = "open" if row["session"] == "OPEN" else "closed"
        if rate > 0:
            metrics["positive"]["total"] += rate
            metrics["positive"][session_key] += rate
        elif rate < 0:
            metrics["negative"]["total"] += rate
            metrics["negative"][session_key] += rate
        metrics["net"]["total"] += rate
        metrics["net"][session_key] += rate
    return {
        "count": len(rows),
        "first_timestamp": rows[0]["timestamp"] if rows else None,
        "last_timestamp": rows[-1]["timestamp"] if rows else None,
        "metrics": metrics,
    }


def build_payload(records: list[dict[str, Any]], sources: list[dict[str, Any]]) -> dict[str, Any]:
    records.sort(key=lambda row: (row["asset"], row["venue"], row["timestamp_ms"]))
    cumulative: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: {"positive": 0.0, "negative": 0.0, "net": 0.0}
    )
    by_series: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        values = cumulative[(row["asset"], row["venue"])]
        rate = row["funding_rate"]
        if rate > 0:
            values["positive"] += rate
        elif rate < 0:
            values["negative"] += rate
        values["net"] += rate
        row["cumulative_positive"] = values["positive"]
        row["cumulative_negative"] = values["negative"]
        row["cumulative_net"] = values["net"]
        by_series[(row["asset"], row["venue"])].append(row)

    assets = []
    for asset in ("CXMT", "UNITREE"):
        configured = [series for series in SERIES if series.asset == asset]
        venues = []
        for series in configured:
            rows = by_series[(series.asset, series.venue)]
            venues.append({"venue": series.venue, "contract": series.contract, **summarize(rows)})
        assets.append(
            {
                "asset": asset,
                "listing_start_ms": configured[0].listing_start_ms,
                "listing_start": iso_utc(configured[0].listing_start_ms),
                "venues": venues,
            }
        )

    live_count = sum(source["mode"] == "live" for source in sources)
    mode = "live" if live_count == len(sources) else "mixed" if live_count else "snapshot"
    last_record_ms = max((row["timestamp_ms"] for row in records), default=None)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "last_record_at": iso_utc(last_record_ms) if last_record_ms else None,
        "record_count": len(records),
        "session_definition": {
            "timezone": "Asia/Shanghai",
            "classification": "settlement timestamp",
            "calendar": "SSE/SZSE official 2026 market-level calendar",
            "open": ["09:15-09:25", "09:30-11:30", "13:00-14:57", "14:57-15:00"],
            "closed": ["09:25-09:30", "11:30-13:00", "15:00-09:15", "weekends", "official holidays"],
        },
        "sources": sources,
        "assets": assets,
        "records": records,
    }


def load_existing_rows(series: FundingSeries) -> list[dict[str, Any]]:
    if not OUTPUT_PATH.exists():
        return []
    try:
        payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [
        row
        for row in payload.get("records", [])
        if row.get("asset") == series.asset and row.get("venue") == series.venue
    ]


def main() -> None:
    existing_payload: dict[str, Any] | None = None
    if OUTPUT_PATH.exists():
        try:
            existing_payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing_payload = None
    records: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for series in SERIES:
        try:
            raw_rows = fetch_binance(series) if series.provider == "binance" else fetch_hyperliquid(series)
            rows = [
                normalize_row(series, row)
                for row in raw_rows
                if int(row.get("fundingTime", row.get("time", 0))) >= series.listing_start_ms
            ]
            if not rows:
                raise ValueError("live source returned zero rows")
            mode = "live"
            message = None
        except Exception as exc:
            rows = load_existing_rows(series)
            mode = "snapshot"
            message = str(exc)[:240]
        records.extend(rows)
        sources.append(
            {
                "asset": series.asset,
                "venue": series.venue,
                "contract": series.contract,
                "mode": mode,
                "rows": len(rows),
                "message": message,
            }
        )

    if not records:
        raise SystemExit("No live data and no existing snapshot; refusing to publish an empty dashboard")
    payload = build_payload(records, sources)
    if existing_payload:
        previous_comparable = {key: value for key, value in existing_payload.items() if key != "generated_at"}
        current_comparable = {key: value for key, value in payload.items() if key != "generated_at"}
        if previous_comparable == current_comparable:
            print(f"snapshot unchanged at {OUTPUT_PATH}")
            for source in sources:
                print(f"{source['asset']}/{source['venue']}: {source['mode']} ({source['rows']} rows)")
            return
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(OUTPUT_PATH)
    print(f"wrote {len(records)} records to {OUTPUT_PATH}")
    for source in sources:
        print(f"{source['asset']}/{source['venue']}: {source['mode']} ({source['rows']} rows)")


if __name__ == "__main__":
    main()
