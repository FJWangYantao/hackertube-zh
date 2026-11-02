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
from concurrent.futures import ThreadPoolExecutor, as_completed
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


def write_manifest(picked: list[dict]) -> None:
    manifest = [
        {key: v.get(key) for key in ("vid", "title", "channel", "score",
                                     "content_type", "summary", "why_hn", "url")}
        for v in picked
    ]
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with (work / "picked.json").open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--sleep", type=float, default=4.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--vid-file", default="")
    args = parser.parse_args()

    SUBS.mkdir(parents=True, exist_ok=True)
    videos = load_videos()
    if args.vid_file:
        wanted = Path(args.vid_file).read_text(encoding="utf-8").split()
        by_vid = {video["vid"]: video for video in videos}
        unknown = [vid for vid in wanted if vid not in by_vid]
        if unknown:
            print(f"unknown vids ({len(unknown)}): {' '.join(unknown)}")
        picked = [by_vid[vid] for vid in wanted if vid in by_vid]
    else:
        picked = pick(videos, args.limit)
        # Write the manifest first so an interrupted run stays resumable.
        write_manifest(picked)
    print(f"target {len(picked)} videos")

    cached = sum(1 for video in picked if has_subs(video["vid"]))
    pending = [video for video in picked if not has_subs(video["vid"])]
    print(f"cached {cached}, fetching {len(pending)}")

    ok = cached
    missing: list[str] = []
    workers = max(1, args.workers)
    done_count = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        # Submit in batches so --sleep actually spaces out requests.
        for start in range(0, len(pending), workers):
            batch = pending[start:start + workers]
            futures = {pool.submit(fetch, video["vid"]): video for video in batch}
            for future in as_completed(futures):
                video = futures[future]
                done_count += 1
                try:
                    fetched = future.result()
                except Exception:  # noqa: BLE001 - one bad video must not stop the run
                    fetched = False
                if fetched:
                    ok += 1
                else:
                    missing.append(video["vid"])
                print(f"[{done_count}/{len(pending)}] {video['vid']} "
                      f"{'ok' if fetched else 'no captions'} {video['title'][:48]}")
            time.sleep(args.sleep)

    if missing:
        print(f"no captions ({len(missing)}): {' '.join(missing)}")
    print(f"done: {ok}/{len(picked)}")


if __name__ == "__main__":
    main()
