#!/usr/bin/env python3
"""Check (and optionally repair) the Chinese subtitle files.

Reads site/data/subs/<vid>.json and reports timelines that would break the
player: unsorted or zero-length cues, blank translations, and transcripts whose
timestamps collapsed into a few seconds.

Usage:
    python -I tools/check_subs.py
    python -I tools/check_subs.py --fix
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBS_DIR = ROOT / "site" / "data" / "subs"
# Chinese has no spaces, so measure characters: speech runs 4-6 per second.
MAX_CHARS_PER_SECOND = 12.0
MIN_CUES = 5


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize(cues: list[dict]) -> list[dict]:
    """Sort by start time, drop blank lines, give every cue a duration."""
    ordered = sorted(
        (cue for cue in cues if str(cue.get("zh", "")).strip()),
        key=lambda cue: cue["s"],
    )
    for index, cue in enumerate(ordered):
        limit = ordered[index + 1]["s"] if index + 1 < len(ordered) else cue["s"] + 4.0
        if cue["e"] <= cue["s"]:
            cue["e"] = cue["s"] + 0.4
        # Trim overlap, but never back to zero when the next cue starts at the
        # same instant as this one.
        if index + 1 < len(ordered) and limit > cue["s"] and cue["e"] > limit:
            cue["e"] = limit
    return ordered


def inspect(cues: list[dict]) -> list[str]:
    problems = []
    if len(cues) < MIN_CUES:
        problems.append(f"only {len(cues)} cues")
    unsorted = sum(1 for a, b in zip(cues, cues[1:]) if b["s"] < a["s"])
    if unsorted:
        problems.append(f"{unsorted} out of order")
    zero = sum(1 for cue in cues if cue["e"] <= cue["s"])
    if zero:
        problems.append(f"{zero} zero-length")
    blank = sum(1 for cue in cues if not str(cue.get("zh", "")).strip())
    if blank:
        problems.append(f"{blank} blank")
    if cues:
        span = cues[-1]["e"] - cues[0]["s"]
        chars = sum(len(str(cue.get("zh", "")).strip()) for cue in cues)
        if span <= 0:
            problems.append("empty timeline")
        elif len(cues) >= 10 and chars / span > MAX_CHARS_PER_SECOND:
            problems.append(f"collapsed timeline ({chars} chars in {span:.0f}s)")
        if cues[-1]["e"] < 60:
            problems.append(f"covers only {cues[-1]['e']:.0f}s")
    return problems


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true",
                        help="sort cues, repair durations, drop blank lines")
    args = parser.parse_args()

    paths = sorted(SUBS_DIR.glob("*.json"))
    bad = 0
    total_cues = 0
    for path in paths:
        try:
            payload = load(path)
        except (ValueError, OSError) as exc:
            print(f"{path.stem}: unreadable ({exc})")
            bad += 1
            continue
        cues = payload.get("cues") or []
        total_cues += len(cues)
        problems = inspect(cues)
        if problems:
            bad += 1
            print(f"{path.stem}: {', '.join(problems)}")
            if args.fix:
                payload["cues"] = [
                    {**cue, "s": round(cue["s"], 2), "e": round(cue["e"], 2)}
                    for cue in normalize(cues)
                ]
                path.write_text(
                    json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                print(f"  fixed -> {len(payload['cues'])} cues")

    print(f"\n{len(paths)} files, {total_cues} cues, {bad} with problems")
    raise SystemExit(1 if bad else 0)


if __name__ == "__main__":
    main()
