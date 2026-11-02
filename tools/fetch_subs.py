#!/usr/bin/env python3
"""Fetch English captions for HackerTube videos with yt-dlp.

Picks the highest-scored videos from data/videos.jsonl (skipping one-off
news clips), then asks YouTube for the English caption track only.

Usage:
    python -I tools/fetch_subs.py --limit 8
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos.jsonl"
SUBS = ROOT / "work" / "subs"
PROXY = os.environ.get("HT_PROXY", "http://127.0.0.1:7890")
SKIP_SHELF = {"news"}
LANGS = ("en", "en-orig")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load_videos() -> list[dict]:
    with VIDEOS.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def pick(videos: list[dict], limit: int) -> list[dict]:
    usable = [v for v in videos if v.get("shelf_life") not in SKIP_SHELF]
    usable.sort(key=lambda v: float(v.get("score") or 0), reverse=True)
    return usable[:limit]


def sub_path(vid: str, lang: str) -> Path:
    return SUBS / f"{vid}.{lang}.vtt"


def has_subs(vid: str) -> bool:
    return any(sub_path(vid, lang).exists() and sub_path(vid, lang).stat().st_size > 500
               for lang in LANGS)


def fetch(vid: str, retries: int = 3) -> bool:
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--proxy", PROXY,
        "--skip-download",
        "--write-auto-subs", "--write-subs",
        "--sub-langs", ",".join(LANGS),
        "--sub-format", "vtt",
        "--no-warnings",
        "-o", str(SUBS / "%(id)s.%(ext)s"),
        f"https://www.youtube.com/watch?v={vid}",
    ]
    for attempt in range(1, retries + 1):
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if has_subs(vid):
            return True
        if "429" in proc.stderr and attempt < retries:
            wait = 30 * attempt
            print(f"    rate limited, retrying in {wait}s")
            time.sleep(wait)
            continue
        tail = (proc.stderr or proc.stdout).strip().splitlines()
        print(f"    failed: {tail[-1][:140] if tail else 'no captions'}")
        return False
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--sleep", type=float, default=4.0)
    args = parser.parse_args()

    SUBS.mkdir(parents=True, exist_ok=True)
    picked = pick(load_videos(), args.limit)
    print(f"target {len(picked)} videos")

    ok = 0
    for index, video in enumerate(picked, 1):
        vid = video["vid"]
        if has_subs(vid):
            print(f"[{index}/{len(picked)}] {vid} cached")
            ok += 1
            continue
        print(f"[{index}/{len(picked)}] {vid} {video['title'][:56]}")
        if fetch(vid):
            ok += 1
        time.sleep(args.sleep)

    manifest = [
        {key: v.get(key) for key in ("vid", "title", "channel", "score",
                                     "content_type", "summary", "why_hn", "url")}
        for v in picked
    ]
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with (work / "picked.json").open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(f"done: {ok}/{len(picked)}")


if __name__ == "__main__":
    main()
