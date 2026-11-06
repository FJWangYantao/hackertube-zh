#!/usr/bin/env python3
"""Fetch English captions through youtube-transcript-api.

The yt-dlp path gets rate limited and bot-checked from datacenter exits; this
library talks to the same caption endpoint through a different route and still
works. Output matches fetch_subs.py: work/subs/<vid>.en.vtt, which make_subs.py
reads unchanged.

Requires the library under work/vendor (work is gitignored):

    python -m pip install --target work/vendor youtube-transcript-api

Usage:
    python -I tools/fetch_subs_api.py --vid-file work/batch200.txt
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "work" / "vendor"))

from youtube_transcript_api import YouTubeTranscriptApi  # noqa: E402
from youtube_transcript_api.proxies import GenericProxyConfig  # noqa: E402

SUBS = ROOT / "work" / "subs"
PROXY = os.environ.get("HT_PROXY", "http://127.0.0.1:7890")
LANGS = ("en", "en-orig")
MIN_BYTES = 500

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_local = threading.local()


def client() -> YouTubeTranscriptApi:
    if not hasattr(_local, "api"):
        _local.api = YouTubeTranscriptApi(
            proxy_config=GenericProxyConfig(http_url=PROXY, https_url=PROXY))
    return _local.api


def has_subs(vid: str) -> bool:
    path = SUBS / f"{vid}.en.vtt"
    return path.exists() and path.stat().st_size > MIN_BYTES


def stamp(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, ms = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def write_vtt(vid: str, snippets: list) -> int:
    lines = ["WEBVTT", ""]
    for snippet in snippets:
        text = " ".join(str(snippet.text).split())
        if not text:
            continue
        start = float(snippet.start)
        end = start + float(snippet.duration)
        lines.extend([f"{stamp(start)} --> {stamp(end)}", text, ""])
    (SUBS / f"{vid}.en.vtt").write_text("\n".join(lines), encoding="utf-8")
    return len(lines)


def fetch(vid: str) -> tuple[str, str]:
    try:
        transcript = client().fetch(vid, languages=list(LANGS))
    except Exception as exc:  # noqa: BLE001 - one video must not stop the run
        return vid, type(exc).__name__
    write_vtt(vid, list(transcript))
    return vid, "ok"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vid-file", required=True)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()

    SUBS.mkdir(parents=True, exist_ok=True)
    vids = Path(args.vid_file).read_text(encoding="utf-8").split()
    pending = [vid for vid in vids if not has_subs(vid)]
    print(f"target {len(vids)}, cached {len(vids) - len(pending)}, fetching {len(pending)}")

    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for done, (vid, result) in enumerate(pool.map(fetch, pending), start=1):
            print(f"[{done}/{len(pending)}] {vid} {result}", flush=True)
            if result != "ok":
                failures.append(f"{vid}:{result}")

    print(f"done: {len(pending) - len(failures)}/{len(pending)}")
    if failures:
        print("failed:", " ".join(failures))


if __name__ == "__main__":
    main()
