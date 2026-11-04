#!/usr/bin/env python3
"""Merge the dataset with Chinese translations into the static site data.

Usage:
    python -I tools/build_site.py

Writes site/data/videos.json (full rows), feed.json (grid fields only),
related.json (vid -> related vids), and meta.json (areas + comment counts).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos.jsonl"
ZH = ROOT / "work" / "videos_zh.jsonl"
TAXONOMY = ROOT / "data" / "taxonomy.json"
RELATED = ROOT / "data" / "related.jsonl"
OUT_DIR = ROOT / "site" / "data"
COMMENTS_DIR = OUT_DIR / "comments"
# One video id per line; lines starting with # are notes.
BLOCKLIST = ROOT / "tools" / "blocklist.txt"

RELATED_LIMIT = 12

AREA_ZH: dict[str, str] = {
    "software": "软件开发与语言",
    "systems-security": "系统、网络与安全",
    "ai-data": "AI、机器学习与数据",
    "math-theory": "数学与理论计算机",
    "hardware": "硬件与电子",
    "computing-history-culture": "计算机历史与文化",
    "design-graphics-media": "设计与视觉媒体",
    "business-economics": "商业、创业与经济",
    "politics-history-society": "政治、历史与社会",
    "physics-space": "物理、太空与化学",
    "life-sciences-health": "生命科学、心智与健康",
    "earth-energy-environment": "地球、能源与环境",
    "engineering-making": "工程、交通与制作",
    "games": "游戏与游戏开发",
    "arts-entertainment": "艺术、喜剧、音乐与影视",
    "ideas-education": "思想、学习与语言",
}

# How many top-scoring rows ship in feed.json before the rest streams in.
FEED_FIRST = 600

FEED_KEYS = (
    "vid",
    "title",
    "title_zh",
    "summary_zh",
    "why_zh",
    "channel",
    "score",
    "content_type",
    "recommenders",
    "first_year",
    "last_year",
    "shelf_life",
)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))


def load_comment_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in sorted(COMMENTS_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        counts[path.stem] = len(payload.get("comments") or [])
    return counts


def load_area_map() -> tuple[dict[str, str], list[dict[str, Any]]]:
    taxonomy = json.loads(TAXONOMY.read_text(encoding="utf-8"))
    category_area: dict[str, str] = {}
    areas: list[dict[str, Any]] = []
    for area in taxonomy.get("areas") or []:
        categories = [c.get("name", "") for c in area.get("categories") or []]
        for name in categories:
            category_area[name] = area["id"]
        areas.append({
            "id": area["id"],
            "name": area.get("name", ""),
            "name_zh": AREA_ZH.get(area["id"], area.get("name", "")),
            "categories": categories,
        })
    return category_area, areas


def load_blocklist() -> set[str]:
    """Videos kept out of the site entirely (see tools/blocklist.txt)."""
    if not BLOCKLIST.exists():
        return set()
    ids = set()
    for line in BLOCKLIST.read_text(encoding="utf-8").splitlines():
        vid = line.split("#", 1)[0].strip()
        if vid:
            ids.add(vid)
    return ids


def main() -> None:
    translations: dict[str, dict] = {}
    if ZH.exists():
        translations = {row["vid"]: row for row in read_jsonl(ZH)}

    category_area, areas = load_area_map()
    comment_counts = load_comment_counts()

    output: list[dict[str, Any]] = []
    for video in read_jsonl(VIDEOS):
        vid = video["vid"]
        zh = translations.get(vid, {})
        hn = video.get("hn") or {}
        categories = [c.get("name", "") for c in video.get("categories") or []]
        area = next((category_area[name] for name in categories if name in category_area), "")
        output.append({
            "vid": vid,
            "title": video.get("title", ""),
            "title_zh": zh.get("title_zh", ""),
            "summary_zh": zh.get("summary_zh", ""),
            "why_zh": zh.get("why_zh", ""),
            "summary": video.get("summary", ""),
            "why_hn": video.get("why_hn", ""),
            "channel": video.get("channel", ""),
            "score": video.get("score"),
            "content_type": video.get("content_type", ""),
            "level": video.get("level", ""),
            "shelf_life": video.get("shelf_life", ""),
            "topic": video.get("primary_topic", ""),
            "area": area,
            "categories": categories,
            "recommenders": hn.get("recommenders"),
            "rec_months": hn.get("rec_months"),
            "first_year": hn.get("first_year"),
            "last_year": hn.get("last_year"),
            "url": video.get("url", ""),
        })

    output.sort(key=lambda row: float(row["score"] or 0), reverse=True)

    blocked = load_blocklist()
    if blocked:
        before = len(output)
        output = [row for row in output if row["vid"] not in blocked]
        sys.stdout.write(f"blocked {before - len(output)} videos\n")

    feed: list[dict[str, Any]] = []
    for row in output:
        entry = {key: row[key] for key in FEED_KEYS}
        entry["why_zh"] = row["why_zh"] or row["why_hn"]
        entry["categories"] = (row["categories"] or [])[:3]
        entry["area"] = row["area"]
        entry["comment_count"] = comment_counts.get(row["vid"], 0)
        feed.append(entry)

    ids = {row["vid"] for row in output}
    related: dict[str, list[str]] = {}
    if RELATED.exists():
        for item in read_jsonl(RELATED):
            vid = item.get("vid")
            if vid not in ids:
                continue
            targets = sorted(
                item.get("related") or [],
                key=lambda entry: -(entry.get("shared_recommenders") or 0),
            )
            picked: list[str] = []
            for entry in targets:
                target = entry.get("vid")
                if target in ids and target != vid and target not in picked:
                    picked.append(target)
                if len(picked) >= RELATED_LIMIT:
                    break
            if picked:
                related[vid] = picked

    write_json(OUT_DIR / "videos.json", output)
    # The first slice renders the home page; the rest streams in afterwards so
    # the first paint does not wait on the whole catalogue.
    write_json(OUT_DIR / "feed.json", feed[:FEED_FIRST])
    write_json(OUT_DIR / "feed-rest.json", feed[FEED_FIRST:])
    write_json(OUT_DIR / "related.json", related)
    write_json(OUT_DIR / "meta.json", {
        "areas": areas,
        "commentCounts": {
            vid: count for vid, count in comment_counts.items() if vid not in blocked
        },
    })

    translated = sum(1 for row in output if row["title_zh"])
    sys.stdout.write(
        f"wrote {len(output)} videos ({translated} translated) to {OUT_DIR}\n"
        f"feed {len(feed)} rows, related {len(related)} sources, "
        f"comments {sum(comment_counts.values())} in {len(comment_counts)} files\n"
    )


if __name__ == "__main__":
    main()
