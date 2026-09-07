from __future__ import annotations

"""Fail closed when the published funding snapshot cannot be reconciled.

The dashboard is used for trading decisions, so this validator deliberately
checks the stored artifact independently from the snapshot builder.  It uses
decimal arithmetic for rates, replays every cumulative value and summary, and
can compare the stored rows with fresh official Binance and Hyperliquid reads.
"""

import argparse
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = ROOT / "site" / "data" / "funding.json"
CHINA_TZ = ZoneInfo("Asia/Shanghai")
DECIMAL_TOLERANCE = Decimal("0.000000000000005")


@dataclass(frozen=True, slots=True)
class Series:
    asset: str
    venue: str
    contract: str
    listing_start_ms: int
    provider: str


SERIES = (
    Series("CXMT", "Binance", "CXMTUSDT", 1_787_029_200_000, "binance"),
    Series("CXMT", "XYZ", "xyz:CXMT", 1_787_029_200_000, "hyperliquid"),
    Series("UNITREE", "Binance", "UNITREEUSDT", 1_787_107_500_000, "binance"),
    Series("UNITREE", "XYZ", "xyz:UNITREE", 1_787_107_500_000, "hyperliquid"),
    Series("UNITREE", "PARA", "para:UNITREE", 1_787_107_500_000, "hyperliquid"),
)
SERIES_BY_KEY = {(series.asset, series.venue): series for series in SERIES}

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


def request_json(url: str, *, payload: dict[str, Any] | None = None) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json", "User-Agent": "FundingLensAudit/1.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = Request(url, data=body, headers=headers, method="POST" if body else "GET")
            with urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"official source request failed: {last_error}")


def decimal_rate(row: dict[str, Any]) -> Decimal:
    value = row.get("funding_rate_raw", row.get("funding_rate"))
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"invalid funding rate {value!r}") from exc
    if not rate.is_finite():
        raise ValueError(f"non-finite funding rate {value!r}")
    return rate


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp has no timezone: {value}")
    return parsed.astimezone(timezone.utc)


def china_date(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(CHINA_TZ).date().isoformat()


def expected_session(timestamp_ms: int) -> tuple[str, str]:
    value = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(CHINA_TZ)
    date_text = value.date().isoformat()
    minute = value.hour * 60 + value.minute
    if value.weekday() >= 5:
        return "CLOSED", "WEEKEND"
    if any(start <= date_text <= end for start, end in OFFICIAL_CLOSED_RANGES_2026):
        return "CLOSED", "HOLIDAY"
    if 555 <= minute < 565:
        return "OPEN", "OPEN_AUCTION"
    if 570 <= minute < 690:
        return "OPEN", "CONTINUOUS_AM"
    if 690 <= minute < 780:
        return "CLOSED", "MIDDAY_BREAK"
    if 780 <= minute < 897:
        return "OPEN", "CONTINUOUS_PM"
    if 897 <= minute < 900:
        return "OPEN", "CLOSE_AUCTION"
    return "CLOSED", "OFF_HOURS"


def empty_metrics() -> dict[str, dict[str, Decimal]]:
    return {
        metric: {bucket: Decimal("0") for bucket in ("total", "open", "closed")}
        for metric in ("positive", "negative", "net")
    }


def summarize(rows: list[dict[str, Any]]) -> dict[str, dict[str, Decimal]]:
    metrics = empty_metrics()
    for row in rows:
        rate = decimal_rate(row)
        session_key = "open" if row["session"] == "OPEN" else "closed"
        if rate > 0:
            metrics["positive"]["total"] += rate
            metrics["positive"][session_key] += rate
        elif rate < 0:
            metrics["negative"]["total"] += rate
            metrics["negative"][session_key] += rate
        metrics["net"]["total"] += rate
        metrics["net"][session_key] += rate
    return metrics


def add_error(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def decimal_matches(actual: Any, expected: Decimal) -> bool:
    try:
        return abs(Decimal(str(actual)) - expected) <= DECIMAL_TOLERANCE
    except (InvalidOperation, ValueError):
        return False


def fetch_live_series(series: Series, end_ms: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = series.listing_start_ms
    for _ in range(100):
        if series.provider == "binance":
            query = urlencode(
                {"symbol": series.contract, "startTime": cursor, "endTime": end_ms, "limit": 1000}
            )
            page = request_json(f"https://fapi.binance.com/fapi/v1/fundingRate?{query}")
            page_limit = 1000
            timestamp_field = "fundingTime"
        else:
            page = request_json(
                "https://api.hyperliquid.xyz/info",
                payload={"type": "fundingHistory", "coin": series.contract, "startTime": cursor, "endTime": end_ms},
            )
            page_limit = 500
            timestamp_field = "time"
        if not isinstance(page, list):
            raise ValueError(f"{series.contract} returned a non-list payload")
        rows.extend(page)
        if not page or len(page) < page_limit:
            break
        next_cursor = int(page[-1][timestamp_field]) + 1
        if next_cursor <= cursor:
            break
        cursor = next_cursor
    # A timestamp is the settlement identity for one contract.  Deduplication
    # here prevents pagination overlap from being mistaken for source data.
    unique = {int(row.get("fundingTime", row.get("time"))): row for row in rows}
    return [unique[key] for key in sorted(unique)]


def audit_snapshot(path: Path, *, require_live: bool, compare_live: bool) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    records = payload.get("records")
    add_error(errors, isinstance(records, list), "records must be a list")
    if not isinstance(records, list):
        records = []

    generated_at = parse_utc(payload["generated_at"])
    generated_ms = int(generated_at.timestamp() * 1000)
    expected_today = generated_at.astimezone(CHINA_TZ).date().isoformat()
    add_error(errors, payload.get("today_date") == expected_today, "today_date is not the Beijing date of generated_at")
    add_error(errors, payload.get("record_count") == len(records), "record_count does not match records length")

    row_keys = [(row.get("asset"), row.get("venue"), row.get("timestamp_ms")) for row in records]
    add_error(errors, len(row_keys) == len(set(row_keys)), "duplicate asset/venue/settlement timestamp rows found")
    add_error(errors, row_keys == sorted(row_keys), "records are not sorted by asset, venue and timestamp")
    add_error(errors, {key[:2] for key in row_keys} == set(SERIES_BY_KEY), "snapshot series set differs from configured five series")

    by_series: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    running: dict[tuple[str, str], dict[str, Decimal]] = defaultdict(
        lambda: {"positive": Decimal("0"), "negative": Decimal("0"), "net": Decimal("0")}
    )
    for index, row in enumerate(records):
        key = (row.get("asset"), row.get("venue"))
        series = SERIES_BY_KEY.get(key)
        if series is None:
            errors.append(f"row {index} has unknown series {key}")
            continue
        timestamp_ms = row.get("timestamp_ms")
        add_error(errors, isinstance(timestamp_ms, int), f"row {index} timestamp_ms is not an integer")
        if not isinstance(timestamp_ms, int):
            continue
        add_error(errors, timestamp_ms >= series.listing_start_ms, f"row {index} predates Binance listing baseline")
        add_error(errors, timestamp_ms <= generated_ms, f"row {index} is later than generated_at")
        add_error(
            errors,
            int(parse_utc(row["timestamp"]).timestamp() * 1000) == timestamp_ms,
            f"row {index} ISO timestamp differs from timestamp_ms",
        )
        expected_market_session, expected_market_state = expected_session(timestamp_ms)
        add_error(errors, row.get("session") == expected_market_session, f"row {index} has incorrect open/closed classification")
        add_error(errors, row.get("market_state") == expected_market_state, f"row {index} has incorrect A-share market state")
        rate = decimal_rate(row)
        add_error(errors, math.isfinite(float(rate)), f"row {index} has a non-finite rate")
        values = running[key]
        if rate > 0:
            values["positive"] += rate
        elif rate < 0:
            values["negative"] += rate
        values["net"] += rate
        for metric in ("positive", "negative", "net"):
            add_error(
                errors,
                decimal_matches(row.get(f"cumulative_{metric}"), values[metric]),
                f"row {index} cumulative_{metric} does not reconcile",
            )
        by_series[key].append(row)

    add_error(
        errors,
        payload.get("today_record_count") == sum(china_date(row["timestamp_ms"]) == expected_today for row in records),
        "today_record_count does not reconcile",
    )
    expected_last = max((row["timestamp_ms"] for row in records), default=None)
    actual_last = None if not payload.get("last_record_at") else int(parse_utc(payload["last_record_at"]).timestamp() * 1000)
    add_error(errors, actual_last == expected_last, "last_record_at does not match the newest settlement")

    assets = {asset["asset"]: asset for asset in payload.get("assets", [])}
    source_map = {(source["asset"], source["venue"]): source for source in payload.get("sources", [])}
    add_error(errors, set(source_map) == set(SERIES_BY_KEY), "source status set differs from configured five series")
    if require_live:
        add_error(errors, payload.get("mode") == "live", "snapshot mode is not live")

    audit_rows: list[dict[str, Any]] = []
    for series in SERIES:
        key = (series.asset, series.venue)
        rows = by_series[key]
        summary = summarize(rows)
        asset = assets.get(series.asset, {})
        venue = next((item for item in asset.get("venues", []) if item.get("venue") == series.venue), None)
        add_error(errors, venue is not None, f"missing summary for {series.asset}/{series.venue}")
        if venue is not None:
            add_error(errors, venue.get("count") == len(rows), f"summary count mismatch for {series.asset}/{series.venue}")
            add_error(errors, venue.get("contract") == series.contract, f"contract mismatch for {series.asset}/{series.venue}")
            for metric, buckets in summary.items():
                for bucket, expected in buckets.items():
                    actual = venue.get("metrics", {}).get(metric, {}).get(bucket)
                    add_error(errors, decimal_matches(actual, expected), f"{series.asset}/{series.venue} {metric}.{bucket} mismatch")
            today_rows = [row for row in rows if china_date(row["timestamp_ms"]) == expected_today]
            today_summary = summarize(today_rows)
            add_error(errors, venue.get("today", {}).get("count") == len(today_rows), f"today count mismatch for {series.asset}/{series.venue}")
            for metric, buckets in today_summary.items():
                for bucket, expected in buckets.items():
                    actual = venue.get("today", {}).get("metrics", {}).get(metric, {}).get(bucket)
                    add_error(errors, decimal_matches(actual, expected), f"today {series.asset}/{series.venue} {metric}.{bucket} mismatch")

        source = source_map.get(key, {})
        add_error(errors, source.get("rows") == len(rows), f"source row count mismatch for {series.asset}/{series.venue}")
        if require_live:
            add_error(errors, source.get("mode") == "live", f"{series.asset}/{series.venue} is not live")
        if rows:
            age_hours = (generated_ms - rows[-1]["timestamp_ms"]) / 3_600_000
            freshness_limit = 12 if series.provider == "binance" else 3
            add_error(errors, age_hours <= freshness_limit, f"{series.asset}/{series.venue} is stale by {age_hours:.2f} hours")
        audit_rows.append(
            {
                "series": f"{series.asset}/{series.venue}",
                "count": len(rows),
                "first_ms": rows[0]["timestamp_ms"] if rows else None,
                "last_ms": rows[-1]["timestamp_ms"] if rows else None,
                "positive_pct": str(summary["positive"]["total"] * 100),
                "negative_pct": str(summary["negative"]["total"] * 100),
                "net_pct": str(summary["net"]["total"] * 100),
            }
        )

    if compare_live:
        exchange_info = request_json("https://fapi.binance.com/fapi/v1/exchangeInfo")
        onboard_dates = {
            item["symbol"]: int(item["onboardDate"])
            for item in exchange_info.get("symbols", [])
            if item.get("symbol") in {"CXMTUSDT", "UNITREEUSDT"}
        }
        for series in SERIES:
            if series.provider == "binance":
                add_error(errors, onboard_dates.get(series.contract) == series.listing_start_ms, f"official onboardDate changed for {series.contract}")
            official_rows = fetch_live_series(series, generated_ms)
            official = {
                int(row.get("fundingTime", row.get("time"))): Decimal(str(row["fundingRate"]))
                for row in official_rows
                if int(row.get("fundingTime", row.get("time"))) >= series.listing_start_ms
            }
            stored = {row["timestamp_ms"]: decimal_rate(row) for row in by_series[(series.asset, series.venue)]}
            add_error(errors, official == stored, f"official rows differ from snapshot for {series.asset}/{series.venue}")

    result = {
        "status": "passed" if not errors else "failed",
        "snapshot": str(path),
        "generated_at": payload.get("generated_at"),
        "record_count": len(records),
        "today_date": expected_today,
        "today_record_count": payload.get("today_record_count"),
        "series": audit_rows,
        "errors": errors,
    }
    if errors:
        raise AssertionError(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit the published funding-rate snapshot")
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--require-live", action="store_true")
    parser.add_argument("--compare-live", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            audit_snapshot(args.snapshot, require_live=args.require_live, compare_live=args.compare_live),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
