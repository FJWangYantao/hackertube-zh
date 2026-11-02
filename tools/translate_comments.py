#!/usr/bin/env python3
"""Translate the Hacker News comments behind the highest-scored videos.

Reads data/mentions.jsonl, keeps only videos inside the top --limit by
score, and writes site/data/comments/<vid>.json with Chinese comment text,
quotes and one-line reasons. Resumable per video, and --retry-empty fills
in comments a previous run left blank.

Usage:
    python -I tools/translate_comments.py --limit 200 --workers 3
    python -I tools/translate_comments.py --retry-empty
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos.jsonl"
MENTIONS = ROOT / "data" / "mentions.jsonl"
OUT_DIR = ROOT / "site" / "data" / "comments"

GATEWAY = "http://127.0.0.1:3425/v1/chat/completions"
MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"
BATCH = 4
MAX_TOKENS = 16000

SYSTEM = (
    "你是中文技术内容编辑，正在翻译 Hacker News 的评论。"
    "输入是 JSON 数组，每项含 i（序号）、text（评论原文）、quote（被引用的片段）、why（一句话理由）。"
    "输出同长度 JSON 数组，每项含 i、text_zh、quote_zh、why_zh：\n"
    "1. 忠实、通顺地译成简体中文，保留原意、语气和口语感；\n"
    "2. 技术名词、人名、产品名、项目名、代码标识保留英文；\n"
    "3. quote 与 why 可能为空字符串，空就输出空字符串；\n"
    "4. 每一条都必须有 text_zh，绝对不能留空；\n"
    "5. 不要增补评论者没说过的内容，不要加解释；\n"
    "6. 只输出 JSON，不要代码块包裹。"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def call_gateway(items: list[dict], timeout: int = 300) -> list[dict]:
    body = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.25,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
        ],
    }
    request = urllib.request.Request(
        GATEWAY,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    content = payload["choices"][0]["message"]["content"].strip()
    content = re.sub(r"^```(?:json)?|```$", "", content, flags=re.M).strip()
    result = json.loads(content)
    if not isinstance(result, list) or len(result) != len(items):
        raise ValueError(f"length mismatch: {len(result)} vs {len(items)}")
    if {row.get("i") for row in result} != {item["i"] for item in items}:
        raise ValueError("index mismatch")
    if any(not str(row.get("text_zh") or "").strip() for row in result):
        raise ValueError("empty translation")
    return result


def translate_batch(items: list[dict]) -> list[dict]:
    try:
        return call_gateway(items)
    except Exception as exc:  # noqa: BLE001 - split and retry
        if len(items) <= 1:
            print(f"    giving up on comment {items[0]['i']}: {exc}")
            return []
        mid = len(items) // 2
        return translate_batch(items[:mid]) + translate_batch(items[mid:])


def translate_rows(comments: list[dict], workers: int) -> list[dict]:
    """Return rows aligned one-to-one with the input comments."""
    payloads = [
        {"i": index, "text": c.get("text", ""), "quote": c.get("quote", ""),
         "why": c.get("why", "")}
        for index, c in enumerate(comments)
    ]
    batches = [payloads[i:i + BATCH] for i in range(0, len(payloads), BATCH)]
    translated: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for rows in pool.map(translate_batch, batches):
            for row in rows:
                translated[row["i"]] = row

    output = []
    for index, comment in enumerate(comments):
        extra = translated.get(index, {})
        output.append({
            "author": comment.get("author", ""),
            "month": comment.get("month", ""),
            "stance": comment.get("stance", ""),
            "story_title": comment.get("story_title", ""),
            "hn_url": comment.get("hn_url", ""),
            "why_zh": extra.get("why_zh") or comment.get("why_zh") or "",
            "quote_zh": extra.get("quote_zh") or comment.get("quote_zh") or "",
            "text_zh": extra.get("text_zh") or comment.get("text_zh") or "",
            "text": comment.get("text", ""),
        })
    return output


def sort_comments(rows: list[dict]) -> list[dict]:
    order = {"strong_rec": 0, "rec": 1, "reference": 2, "joke": 3, "critical": 4}
    return sorted(rows, key=lambda c: (order.get(c["stance"], 9), c["month"]))


def retry_empty(workers: int) -> None:
    files = sorted(OUT_DIR.glob("*.json"))
    total_fixed = 0
    for path in files:
        payload = json.loads(path.read_text(encoding="utf-8"))
        comments = payload.get("comments", [])
        todo = [c for c in comments if not str(c.get("text_zh") or "").strip()]
        if not todo:
            continue
        print(f"  {payload['vid']}: retrying {len(todo)} blank comments")
        fixed = translate_rows(todo, workers)
        by_key = {(c["author"], c["month"], c["text"]): c for c in fixed}
        for index, comment in enumerate(comments):
            key = (comment.get("author"), comment.get("month"), comment.get("text"))
            replacement = by_key.get(key)
            if replacement is not None:
                comments[index] = replacement
        payload["comments"] = sort_comments(comments)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        total_fixed += sum(1 for c in comments if c.get("text_zh"))
    print(f"retry pass done, {total_fixed} comments now translated")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--retry-empty", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if args.retry_empty:
        retry_empty(args.workers)
        return

    with VIDEOS.open(encoding="utf-8") as fh:
        videos = [json.loads(line) for line in fh if line.strip()]
    videos.sort(key=lambda v: float(v.get("score") or 0), reverse=True)
    chosen = [v["vid"] for v in videos[:args.limit]]
    chosen_set = set(chosen)

    grouped: defaultdict[str, list[dict]] = defaultdict(list)
    with MENTIONS.open(encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            mention = json.loads(line)
            if mention["vid"] in chosen_set:
                grouped[mention["vid"]].append(mention)

    todo = [vid for vid in chosen
            if args.force or not (OUT_DIR / f"{vid}.json").exists()]
    print(f"{len(chosen)} videos in scope, {len(todo)} to translate, "
          f"{sum(len(grouped.get(v, [])) for v in todo)} comments")

    for index, vid in enumerate(todo, 1):
        comments = grouped.get(vid, [])
        if not comments:
            continue
        rows = sort_comments(translate_rows(comments, args.workers))
        with (OUT_DIR / f"{vid}.json").open("w", encoding="utf-8") as fh:
            json.dump({"vid": vid, "comments": rows}, fh, ensure_ascii=False)
        blank = sum(1 for row in rows if not row["text_zh"])
        print(f"  [{index}/{len(todo)}] {vid}: {len(rows)} comments, {blank} blank")
        time.sleep(0.1)

    print("done")


if __name__ == "__main__":
    main()
