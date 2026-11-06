#!/usr/bin/env python3
"""Build a compact video-level inverted index over subtitle text.

Usage:
    python -I tools/subindex.py

Reads site/data/subs/<vid>.json and writes site/data/subs-index.json:

    {"v": ["vidA", "vidB"], "i": {"cap": "3 5 1a", "分布式": "0"}}

Tokens are lowercase English words (>= 2 chars, minus a small stopword list)
plus CJK character bigrams from the Chinese cue text. Postings are video
indices delta-encoded in base 36 and joined with spaces (~7 MB raw, ~3 MB gzip
for the full corpus), so the front end can lazily fetch the index, intersect
postings to find candidate videos, and then load the per-video subtitle file to
pinpoint the exact cue and timestamp.

Tokens that appear in fewer than MIN_VIDEOS videos are dropped: they bloat the
file while contributing almost no recall (title/summary search still covers
them).

Keep STOPWORDS in sync with site/js/subsearch.js.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBS_DIR = ROOT / "site" / "data" / "subs"
OUT_PATH = ROOT / "site" / "data" / "subs-index.json"

# Keep in sync with site/js/subsearch.js.
STOPWORDS = frozenset(
    "the a an and or of to in on for is are was were be been being it its "
    "this that these those i you he she we they as at by with from but not "
    "no do does did so if then than there here what which who when how all "
    "can will just don should now".split()
)

WORD_RE = re.compile(r"[0-9a-z][0-9a-z'-]+")

MIN_FILE_BYTES = 20
# A token seen in a single video costs a key but adds almost no recall.
MIN_VIDEOS = 2

DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
    )


def extract_tokens(cues: list[dict]) -> set[str]:
    """Tokens for one video: English words + CJK bigrams over all cues."""
    tokens: set[str] = set()
    for cue in cues:
        for word in WORD_RE.findall((cue.get("en") or "").lower()):
            if word not in STOPWORDS:
                tokens.add(word)
        chars = [ch for ch in (cue.get("zh") or "") if is_cjk(ch)]
        tokens.update(a + b for a, b in zip(chars, chars[1:]))
    return tokens


def to_base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = []
    while value:
        value, rem = divmod(value, 36)
        digits.append(DIGITS[rem])
    return "".join(reversed(digits))


def encode_postings(indices: list[int]) -> str:
    """[3, 10, 47] -> "3 7 11" (ascending deltas in base 36)."""
    deltas = [indices[0]] + [b - a for a, b in zip(indices, indices[1:])]
    return " ".join(to_base36(delta) for delta in deltas)


def build_index(subs_dir: Path = SUBS_DIR) -> dict:
    """Scan every subtitle file and return the postings payload."""
    if not subs_dir.exists():
        raise SystemExit(f"subtitle dir not found: {subs_dir}")
    vids = sorted(
        path.stem for path in subs_dir.glob("*.json") if path.stat().st_size > MIN_FILE_BYTES
    )
    occurrences: dict[str, set[int]] = {}
    for idx, vid in enumerate(vids):
        path = subs_dir / f"{vid}.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:  # JSON and Unicode errors are ValueErrors
            print(f"  skipping {vid}: {exc}")
            continue
        if not isinstance(payload, dict):
            print(f"  skipping {vid}: unexpected JSON shape")
            continue
        for token in extract_tokens(payload.get("cues") or []):
            occurrences.setdefault(token, set()).add(idx)
    postings = {
        token: encode_postings(sorted(occurred))
        for token, occurred in occurrences.items()
        if len(occurred) >= MIN_VIDEOS
    }
    return {"v": vids, "i": postings}


def write_index(index: dict, out_path: Path = OUT_PATH) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))
    entries = sum(len(ids.split()) for ids in index["i"].values())
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(
        f"subindex: {len(index['v'])} videos, {len(index['i'])} tokens, "
        f"{entries} postings, {size_mb:.2f} MB -> {out_path.name}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subs-dir", default=str(SUBS_DIR))
    parser.add_argument("--out", default=str(OUT_PATH))
    args = parser.parse_args()
    index = build_index(Path(args.subs_dir))
    write_index(index, Path(args.out))


if __name__ == "__main__":
    main()
