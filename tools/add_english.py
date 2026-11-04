#!/usr/bin/env python3
"""Attach the English source line to already-generated subtitles.

The subtitle JSON only keeps the Chinese translation. This reads the same
source the translation came from — work/subs/<source>.vtt for caption-based
videos, work/audio/<vid>.gemini.json for transcribed ones — and matches cues
by their start time, so nothing has to be re-translated.

Usage:
    python -I tools/add_english.py
    python -I tools/add_english.py --force
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_subs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SUBS_DIR = ROOT / "site" / "data" / "subs"
VTT_DIR = ROOT / "work" / "subs"
CACHE_DIR = ROOT / "work" / "audio"
TOLERANCE = 0.05


def source_lines(vid: str, payload: dict) -> list[tuple[float, str]]:
    source = payload.get("source") or ""
    if source.endswith(".vtt"):
        path = VTT_DIR / source
        if path.exists():
            return [(cue["s"], cue["en"]) for cue in make_subs.parse_vtt(path)]
    cache = CACHE_DIR / f"{vid}.gemini.json"
    if cache.exists():
        segments = json.loads(cache.read_text(encoding="utf-8"))
        return [(float(seg["start"]), str(seg["text"]).strip())
                for seg in segments if seg.get("text")]
    return []


def attach(cues: list[dict], lines: list[tuple[float, str]]) -> int:
    """Fill cue["en"] by start time; returns how many cues were matched."""
    buckets: dict[float, list[str]] = {}
    for start, text in lines:
        buckets.setdefault(round(start, 2), []).append(text)
    matched = 0
    for cue in cues:
        bucket = buckets.get(round(cue["s"], 2))
        if not bucket:
            near = next((key for key in buckets
                         if abs(key - cue["s"]) <= TOLERANCE and buckets[key]), None)
            bucket = buckets[near] if near is not None else None
        if bucket:
            cue["en"] = bucket.pop(0)
            matched += 1
    return matched


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true",
                        help="redo files that already carry English")
    args = parser.parse_args()

    done = 0
    skipped = 0
    for path in sorted(SUBS_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        cues = payload.get("cues") or []
        if not cues:
            continue
        if not args.force and all("en" in cue for cue in cues):
            skipped += 1
            continue
        lines = source_lines(path.stem, payload)
        if not lines:
            print(f"{path.stem}: no English source, skipped")
            continue
        matched = attach(cues, lines)
        missing = len(cues) - matched
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        done += 1
        note = f", {missing} without English" if missing else ""
        print(f"{path.stem}: {matched}/{len(cues)} matched{note}")

    print(f"\nupdated {done} files, skipped {skipped}")


if __name__ == "__main__":
    main()
