#!/usr/bin/env python3
"""Summarize the HackerTube export.

Reads the .jsonl files from DATA and writes CSV tables plus an overview
report to OUT. Standard library only, so it runs on a bare Python.

Usage:
    python -I summarize.py <data-dir> <out-dir>
"""

import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from typing import Any, Counter as CounterType, Iterable, Iterator, Optional, Sequence

FIELDNAMES_VIDEO: list[str] = [
    "vid", "title", "channel", "content_type", "level", "shelf_life",
    "score", "rec_months", "recommenders", "strong_recs", "mentions",
    "first_year", "last_year", "primary_topic", "categories", "tags",
    "summary", "why_hn", "url",
]


def iter_jsonl(path: str) -> Iterator[dict[str, Any]]:
    """Yield one parsed object per non-empty line."""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def pct(part: int, whole: int) -> str:
    return f"{part / whole * 100:.1f}%" if whole else "0.0%"


def normalize_title(title: Optional[str]) -> str:
    """Crude dedupe key: lowercase, strip punctuation and whitespace."""
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def write_csv(path: str, fieldnames: Sequence[str], records: Iterable[dict[str, Any]]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(fieldnames), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def flatten_video(v: dict[str, Any]) -> dict[str, Any]:
    """Flatten one video record into a single CSV row."""
    hn = v.get("hn") or {}
    return {
        "vid": v.get("vid"),
        "title": v.get("title"),
        "channel": v.get("channel"),
        "content_type": v.get("content_type"),
        "level": v.get("level"),
        "shelf_life": v.get("shelf_life"),
        "score": v.get("score"),
        "rec_months": hn.get("rec_months"),
        "recommenders": hn.get("recommenders"),
        "strong_recs": hn.get("strong_recs"),
        "mentions": hn.get("mentions"),
        "first_year": hn.get("first_year"),
        "last_year": hn.get("last_year"),
        "primary_topic": v.get("primary_topic"),
        "categories": " | ".join(c.get("name", "") for c in v.get("categories") or []),
        "tags": " | ".join(v.get("tags") or []),
        "summary": v.get("summary"),
        "why_hn": v.get("why_hn"),
        "url": v.get("url"),
    }


def counter_table(
    title: str,
    counter: CounterType[str],
    total: int,
    head: Optional[int] = None,
) -> str:
    lines = [f"| {title} | 数量 | 占比 |", "| --- | ---: | ---: |"]
    items = counter.most_common(head) if head else counter.most_common()
    for name, count in items:
        lines.append(f"| {name} | {count:,} | {pct(count, total)} |")
    return "\n".join(lines)


def main() -> None:
    data_dir: str = sys.argv[1] if len(sys.argv) > 1 else "data"
    out_dir: str = sys.argv[2] if len(sys.argv) > 2 else "reports"
    os.makedirs(out_dir, exist_ok=True)

    videos: list[dict[str, Any]] = list(iter_jsonl(os.path.join(data_dir, "videos.jsonl")))
    mentions: list[dict[str, Any]] = list(iter_jsonl(os.path.join(data_dir, "mentions.jsonl")))
    related_path: str = os.path.join(data_dir, "related.jsonl")
    related: list[dict[str, Any]] = list(iter_jsonl(related_path)) if os.path.exists(related_path) else []

    total_v: int = len(videos)
    total_m: int = len(mentions)

    # --- integrity checks -------------------------------------------------
    vids = [v.get("vid") for v in videos]
    mention_vids = {m.get("vid") for m in mentions}
    no_rec = sum(1 for v in videos if (v.get("hn") or {}).get("recommenders", 0) == 0)
    checks: list[tuple[str, str]] = [
        ("videos.jsonl 行数", f"{total_v:,}"),
        ("mentions.jsonl 行数", f"{total_m:,}"),
        ("vid 唯一", f"{len(set(vids)):,} / {total_v:,}"),
        ("有评论记录的视频", f"{len(mention_vids):,} / {total_v:,}"),
        ("只有引用、无推荐的视频", f"{no_rec:,}"),
        ("related.jsonl 条数", f"{len(related):,}"),
    ]
    dup_titles = [t for t, n in Counter(normalize_title(v.get("title")) for v in videos).items() if n > 1]
    checks.append(("疑似重复标题", f"{len(dup_titles):,} 组"))

    # --- distributions ----------------------------------------------------
    content_types = Counter(v.get("content_type") or "(空)" for v in videos)
    levels = Counter(v.get("level") or "(空)" for v in videos)
    shelves = Counter(v.get("shelf_life") or "(空)" for v in videos)
    stances = Counter(m.get("stance") or "(空)" for m in mentions)
    areas: CounterType[str] = Counter()
    categories: CounterType[str] = Counter()
    for v in videos:
        for c in v.get("categories") or []:
            categories[c.get("name", "?")] += 1
            areas[c.get("area_name", "?")] += 1
    years = Counter(str(m.get("month", ""))[:4] for m in mentions if m.get("month"))

    channels: CounterType[str] = Counter(v.get("channel") or "(空)" for v in videos)
    channel_scores: defaultdict[str, float] = defaultdict(float)
    for v in videos:
        name = v.get("channel") or "(空)"
        channel_scores[name] += float(v.get("score") or 0)

    # --- tables -----------------------------------------------------------
    ranked = sorted(videos, key=lambda v: float(v.get("score") or 0), reverse=True)
    rows = [flatten_video(v) for v in ranked]
    write_csv(os.path.join(out_dir, "videos.csv"), FIELDNAMES_VIDEO, rows)
    write_csv(os.path.join(out_dir, "top_videos.csv"), FIELDNAMES_VIDEO, rows[:200])

    cat_rows = [{"category": k, "videos": n, "share": pct(n, total_v)}
                for k, n in categories.most_common()]
    write_csv(os.path.join(out_dir, "categories.csv"), ["category", "videos", "share"], cat_rows)

    chan_rows = [{"channel": k, "videos": n, "total_score": round(channel_scores[k], 1)}
                 for k, n in channels.most_common()]
    write_csv(os.path.join(out_dir, "channels.csv"), ["channel", "videos", "total_score"], chan_rows)

    year_rows = [{"year": k, "mentions": n} for k, n in sorted(years.items())]
    write_csv(os.path.join(out_dir, "mentions_by_year.csv"), ["year", "mentions"], year_rows)

    # --- overview ---------------------------------------------------------
    top_lines = ["| # | 视频 | 频道 | 分数 | 推荐月数 | 类型 |",
                 "| ---: | --- | --- | ---: | ---: | --- |"]
    for i, v in enumerate(rows[:25], 1):
        title = (v["title"] or "").replace("|", "\\|")
        if len(title) > 70:
            title = title[:67] + "..."
        channel = (v["channel"] or "").replace("|", "\\|")
        top_lines.append(
            f"| {i} | [{title}]({v['url']}) | {channel} | {v['score']} | {v['rec_months']} | {v['content_type']} |"
        )

    year_lines = "\n".join(f"| {y} | {n:,} |" for y, n in sorted(years.items()))

    doc = f"""# HackerTube 数据概览

由 `tools/summarize.py` 生成，数据导出日期 2026-10-31。

## 完整性校验

| 项目 | 值 |
| --- | --- |
""" + "\n".join(f"| {k} | {v} |" for k, v in checks) + f"""

## 内容类型

{counter_table("content_type", content_types, total_v)}

## 难度

{counter_table("level", levels, total_v)}

## 时效性

{counter_table("shelf_life", shelves, total_v)}

## 评论立场（{total_m:,} 条评论）

{counter_table("stance", stances, total_m)}

## 领域（一个视频可计入多个领域）

{counter_table("area_name", areas, total_v)}

## Top 15 主题

{counter_table("category", categories, total_v, head=15)}

## Top 15 频道

{counter_table("channel", channels, total_v, head=15)}

## 评论年份分布

| 年份 | 评论数 |
| --- | ---: |
{year_lines}

## 分数最高的 25 个视频

{chr(10).join(top_lines)}

---

数据来源：[HackerTube](https://hackertube.org)（ODC-By 1.0），评论来自
[open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) 数据集。
分类、摘要与立场标注由 LLM 生成，存在少量误差。
"""
    with open(os.path.join(out_dir, "overview.md"), "w", encoding="utf-8") as fh:
        fh.write(doc)

    print(f"videos={total_v} mentions={total_m} related={len(related)}")
    print(f"wrote 6 files to {out_dir}")


if __name__ == "__main__":
    main()
