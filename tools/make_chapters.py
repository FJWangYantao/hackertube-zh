#!/usr/bin/env python3
"""Generate AI chapter outlines (TL;DR + chapters) for subtitled videos.

Usage:
    python -I tools/make_chapters.py --limit 20 --workers 4
    python -I tools/make_chapters.py --vid-file work/chapter_list.txt
    python -I tools/make_chapters.py --vids SxdOUGdseq4 --force

For every video that already has site/data/subs/<vid>.json, ask the local
gateway (same endpoint as make_subs.py) for a Chinese TL;DR plus timestamped
chapter titles, validate the timeline, and write site/data/chapters/<vid>.json:

    {"vid": "SxdOUGdseq4", "tldr": "……", "dur": 3180.5,
     "chapters": [{"s": 0, "t": "开场"}, {"s": 214, "t": "……"}],
     "model": "…"}

Raw model replies are cached in work/chapters/<vid>.json so a re-run (or a
future re-prompt) never re-calls the model unless --force is given.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBS_DIR = ROOT / "site" / "data" / "subs"
OUT_DIR = ROOT / "site" / "data" / "chapters"
RAW_DIR = ROOT / "work" / "chapters"

GATEWAY = os.environ.get("HT_GATEWAY", "http://127.0.0.1:3425/v1/chat/completions")
MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"
WORKERS = 4

SYSTEM = (
    "你是一名技术视频编辑，负责为英文技术演讲提炼中文大纲。"
    "你的输出必须是严格的 JSON，不要包含任何其他文字或代码块标记。"
)

# Chapters closer than this (seconds) are treated as the same beat.
MIN_GAP = 45
# Window seconds used to pack the transcript fed to the model.
MIN_WINDOW = 10.0
MAX_WINDOWS = 900
MAX_LINE_CHARS = 400
MIN_CHAPTERS = 3
MAX_CHAPTERS = 24
TLDR_MAX_CHARS = 180


def stamp(seconds: float) -> str:
    total = max(0, int(seconds))
    return f"{total // 60}:{total % 60:02d}"


def build_transcript(cues: list[dict]) -> list[tuple[float, str]]:
    """Pack cues into ~10s windows so the prompt stays compact but complete."""
    duration = max(cue["e"] for cue in cues)
    window = max(MIN_WINDOW, duration / MAX_WINDOWS)
    lines: list[tuple[float, str]] = []
    start = cues[0]["s"]
    buf: list[str] = []
    for cue in cues:
        text = (cue.get("en") or cue.get("zh") or "").strip()
        if text:
            buf.append(text)
        if cue["e"] - start >= window and buf:
            lines.append((start, " ".join(buf)[:MAX_LINE_CHARS]))
            start = max(start + window, cue["e"])
            buf = []
    if buf:
        lines.append((start, " ".join(buf)[:MAX_LINE_CHARS]))
    return lines


def build_prompt(lines: list[tuple[float, str]]) -> str:
    transcript = "\n".join(f"[{stamp(s)}] {text}" for s, text in lines)
    return (
        "下面是一场技术视频的字幕稿（带时间戳）。请完成两件事：\n"
        "1. 用不超过 80 个字总结这场演讲的核心内容（tldr）。\n"
        "2. 把视频划分为 4~12 个章节（chapters），每个章节给出起始秒数 s"
        "（整数，以字幕时间戳为准）和不超过 12 个字的中文章节标题 t。"
        "第一个章节从 0 开始，章节按时间升序，覆盖到结尾。\n"
        '只输出 JSON：{"tldr": "…", "chapters": [{"s": 0, "t": "…"}, …]}\n\n'
        f"字幕稿：\n{transcript}"
    )


def parse_payload(content: str) -> dict:
    """Best-effort JSON extraction from a model reply that may carry fences."""
    text = re.sub(r"```[a-zA-Z]*|```", "", content).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start:end + 1])


def sanitize(raw: object, duration: float) -> dict | None:
    """Validate and clamp a parsed outline; None means unusable."""
    if not isinstance(raw, dict):
        return None
    tldr = str(raw.get("tldr") or "").strip()
    if len(tldr) < 10:
        return None
    ceiling = max(1, int(duration) - 1)
    chapters: list[dict] = []
    last = -(10**9)
    items = raw.get("chapters")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            second = int(round(float(item.get("s"))))
        except (TypeError, ValueError):
            continue
        title = str(item.get("t") or "").strip()
        if not title:
            continue
        second = max(0, min(second, ceiling))
        if second - last < MIN_GAP:
            continue
        chapters.append({"s": second, "t": title[:16]})
        last = second
    if chapters and chapters[0]["s"] > 90:
        chapters.insert(0, {"s": 0, "t": "开场"})
    if len(chapters) < MIN_CHAPTERS:
        return None
    return {"tldr": tldr[:TLDR_MAX_CHARS], "chapters": chapters[:MAX_CHAPTERS]}


def call_model(prompt: str, model: str, timeout: int = 180, attempts: int = 3) -> str:
    body = {
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
    }
    request = urllib.request.Request(
        GATEWAY,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
            return payload["choices"][0]["message"]["content"].strip()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt == attempts:
                raise
            print(f"  retry {attempt}: {exc}")
            time.sleep(1.5 * attempt)
    raise RuntimeError("unreachable")


def load_cached(vid: str) -> dict | None:
    path = RAW_DIR / f"{vid}.json"
    if not path.exists():
        return None
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return cached.get("parsed") if isinstance(cached.get("parsed"), dict) else None


def build(vid: str, model: str, force: bool = False) -> bool:
    out_path = OUT_DIR / f"{vid}.json"
    if out_path.exists() and not force:
        return False
    subs_path = SUBS_DIR / f"{vid}.json"
    if not subs_path.exists():
        print(f"  {vid}: no subtitles, skipped")
        return False
    cues = json.loads(subs_path.read_text(encoding="utf-8")).get("cues") or []
    cues = [cue for cue in cues if (cue.get("en") or cue.get("zh"))]
    if not cues:
        print(f"  {vid}: empty cues, skipped")
        return False
    duration = max(cue["e"] for cue in cues)

    parsed = None if force else load_cached(vid)
    if parsed is None:
        prompt = build_prompt(build_transcript(cues))
        parsed = parse_payload(call_model(prompt, model))
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        (RAW_DIR / f"{vid}.json").write_text(
            json.dumps({"model": model, "parsed": parsed}, ensure_ascii=False),
            encoding="utf-8",
        )

    outline = sanitize(parsed, duration)
    if outline is None:
        print(f"  {vid}: model outline unusable, skipped")
        return False
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"vid": vid, **outline, "dur": round(duration, 2), "model": model}
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  {vid}: {len(outline['chapters'])} chapters written")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vids", nargs="*", default=[])
    parser.add_argument("--vid-file", default="")
    parser.add_argument("--all", action="store_true", help="process every subtitled video")
    parser.add_argument("--only-missing", action="store_true",
                        help="with --all, skip videos that already have chapters")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=WORKERS)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    vids = args.vids
    if args.vid_file:
        vids = Path(args.vid_file).read_text(encoding="utf-8").split()
    if not vids and not args.all and args.limit <= 0:
        parser.error("choose a scope: --vids / --vid-file / --all, or cap a batch with --limit")
    if not vids and args.all:
        vids = sorted(path.stem for path in SUBS_DIR.glob("*.json"))
    elif not vids:
        # Prefer the highest-scoring videos; feed slices are score-sorted.
        available = {path.stem for path in SUBS_DIR.glob("*.json")}
        ordered: list[str] = []
        for name in ("feed.json", "feed-rest.json"):
            feed_path = ROOT / "site" / "data" / name
            if feed_path.exists():
                ordered.extend(
                    row["vid"] for row in json.loads(feed_path.read_text(encoding="utf-8"))
                )
        vids = [vid for vid in dict.fromkeys(ordered) if vid in available] or sorted(available)
    if args.only_missing:
        vids = [vid for vid in vids if not (OUT_DIR / f"{vid}.json").exists()]
    if args.limit > 0:
        vids = vids[:args.limit]
    if not vids:
        print("nothing to do (all videos already have chapters?)")
        return

    def run(vid: str) -> bool:
        try:
            return build(vid, model=args.model, force=args.force)
        except Exception as exc:  # noqa: BLE001
            print(f"  {vid}: FAILED {exc}")
            return False

    unique = list(dict.fromkeys(vids))
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        done = sum(pool.map(run, unique))
    print(f"chapters: {done} written, {len(unique) - done} skipped/failed")


if __name__ == "__main__":
    main()
