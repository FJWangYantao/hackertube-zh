#!/usr/bin/env python3
"""Build site/data/series.json: ordered episode groups (合集) from titles.

Two heuristics, both scoped to a single channel:
  numbered — a title segment carrying "Part 2 / Chapter 3 / Ep 5 / #12 / 2/5"
             markers; grouping key is that segment with the marker removed.
  shared   — a title segment ("A | B", "A - B") shared by >= MIN_SHARED videos
             of the channel, ordered by year then HN score.

Each video joins at most one series (numbered wins, larger groups win). The
output is consumed by site/js/series.js for the watch-page 合集 strip and
ordered autoplay. videos.json is read-only; series.json is written atomically.

Usage:
    python -I tools/make_series.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS_PATH = ROOT / "site" / "data" / "videos.json"
OUT_PATH = ROOT / "site" / "data" / "series.json"

MIN_NUMBERED = 2  # a numbered series needs at least this many episodes
MIN_SHARED = 3    # an unnumbered series needs at least this many titles
MAX_SHARED = 40   # bigger shared buckets are just "the whole channel"
MIN_NAME_LEN = 4  # grouping keys shorter than this are noise
STOP_KEYS = {
    "part", "chapter", "episode", "ep", "lecture", "lesson", "full",
    "complete", "official", "video", "talk", "new", "best", "highlights",
    "live", "hd", "trailer", "shorts", "podcast", "course", "series",
    "season",
}

NUMBER_RE = re.compile(
    r"(?:\b(?:chapter|part|episode|ep|lecture|lesson|module|session|section"
    r"|unit|day|week|vol)\.?\s*#?\s*(\d{1,3})\b"
    r"|#\s*(\d{1,3})\b"
    r"|\b(\d{1,2})\s*/\s*\d{1,2}\b)",
    re.IGNORECASE,
)
SEGMENT_SPLIT = re.compile(r"\s+[|–—]\s+|\s+-\s+")


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def clean_key(segment: str) -> str | None:
    """Grouping key for a title segment, or None if it is noise."""
    key = normalize(segment)
    if len(key) < MIN_NAME_LEN or key in STOP_KEYS or key.isdigit():
        return None
    return key


def parse_segment(segment: str) -> tuple[int | None, str | None]:
    """Extract (episode number, cleaned key) from one title segment."""
    match = NUMBER_RE.search(segment)
    if not match:
        return None, clean_key(segment)
    number = int(next(g for g in match.groups() if g))
    remainder = segment[:match.start()] + " " + segment[match.end():]
    return number, clean_key(remainder)


def build_groups(rows: list[dict]) -> dict:
    """channel -> key -> {vid: entry} with entry = {vid, num, score, year}."""
    groups: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(dict))
    for row in rows:
        channel = (row.get("channel") or "").strip()
        title = row.get("title") or ""
        if not channel or not title:
            continue
        channel_key = normalize(channel)
        for segment in SEGMENT_SPLIT.split(title):
            number, key = parse_segment(segment)
            if not key or key == channel_key:
                continue
            entry = groups[channel][key].setdefault(
                row["vid"],
                {"vid": row["vid"], "num": None,
                 "score": row.get("score") or 0,
                 "year": row.get("first_year") or 0},
            )
            if number is not None:
                entry["num"] = number
    return groups


def display_title(entries: list[dict], raw_rows: dict, key: str) -> str:
    """Pick the most frequent original spelling of the grouping segment."""
    counts: dict[str, int] = defaultdict(int)
    for entry in entries:
        row = raw_rows.get(entry["vid"], {})
        for segment in SEGMENT_SPLIT.split(row.get("title") or ""):
            if clean_key(segment) == key:
                counts[segment.strip(" ,.-–—|")] += 1
    if counts:
        return max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
    return key.title()


def series_id(channel: str, key: str) -> str:
    digest = hashlib.md5(f"{channel}|{key}".encode("utf-8")).hexdigest()[:10]
    return "s" + digest


def emit_series(groups: dict, raw_rows: dict) -> list[dict]:
    numbered: list[tuple[str, str, list[dict]]] = []
    shared: list[tuple[str, str, list[dict]]] = []
    for channel, keys in groups.items():
        for key, members in keys.items():
            entries = list(members.values())
            with_num = [e for e in entries if e["num"] is not None]
            if len({e["num"] for e in with_num}) >= 2 and len(with_num) >= MIN_NUMBERED:
                ordered = sorted(
                    entries,
                    key=lambda e: (e["num"] if e["num"] is not None else 999, -e["score"]),
                )
                numbered.append((channel, key, ordered))
            elif MIN_SHARED <= len(entries) <= MAX_SHARED:
                ordered = sorted(entries, key=lambda e: (e["year"], -e["score"]))
                shared.append((channel, key, ordered))

    series: list[dict] = []
    used: set[str] = set()
    for kind, bucket in (("numbered", numbered), ("shared", shared)):
        floor = MIN_NUMBERED if kind == "numbered" else MIN_SHARED
        for channel, key, entries in sorted(bucket, key=lambda item: -len(item[2])):
            vids = [e["vid"] for e in entries if e["vid"] not in used]
            if len(vids) < floor:
                continue
            used.update(vids)
            series.append({
                "id": series_id(channel, key),
                "title": display_title(entries, raw_rows, key),
                "channel": channel,
                "kind": kind,
                "count": len(vids),
                "vids": vids,
            })
    return series


def main() -> int:
    if not VIDEOS_PATH.exists():
        print(f"missing {VIDEOS_PATH}; run build_site.py first", file=sys.stderr)
        return 1
    rows = json.loads(VIDEOS_PATH.read_text(encoding="utf-8"))
    raw_rows = {row["vid"]: row for row in rows}
    series = emit_series(build_groups(rows), raw_rows)
    series.sort(key=lambda item: -item["count"])
    by_vid = {vid: item["id"] for item in series for vid in item["vids"]}
    payload = {
        "version": 1,
        "generated_at": date.today().isoformat(),
        "series": series,
        "byVid": by_vid,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_PATH.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(OUT_PATH)
    n_numbered = sum(1 for item in series if item["kind"] == "numbered")
    print(f"series: {len(series)} ({n_numbered} numbered), "
          f"videos covered: {len(by_vid)}/{len(rows)} -> {OUT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
