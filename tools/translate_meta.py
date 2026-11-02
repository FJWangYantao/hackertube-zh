#!/usr/bin/env python3
"""Translate every video's title, summary and "why HN likes it" to Chinese.

Reads data/videos.jsonl, writes work/videos_zh.jsonl one record per video
({vid, title_zh, summary_zh, why_zh}). Resumable: records already present
in the output file are skipped, so interrupting is safe.

Usage:
    python -I tools/translate_meta.py --batch 12 --workers 4
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos.jsonl"
OUT = ROOT / "work" / "videos_zh.jsonl"

GATEWAY = "http://127.0.0.1:3425/v1/chat/completions"
MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"

SYSTEM = (
    "你是中文技术内容编辑。输入是 JSON 数组，每个元素含 vid、title、summary、why_hn。"
    "请为每一条产出 title_zh、summary_zh、why_zh：\n"
    "1. title_zh：准确自然的中文标题，人名、产品名、项目名保留英文；\n"
    "2. summary_zh：两句话以内的中文简介，通顺，不要逐字直译；\n"
    "3. why_zh：一句话说明 Hacker News 为什么推荐它；\n"
    "4. 输出 JSON 数组，元素数量与输入相同，每个元素保留原 vid 并含上述三个字段；\n"
    "5. 只输出 JSON，不要代码块包裹，不要解释。"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def call_gateway(items: list[dict], timeout: int = 240) -> list[dict]:
    body = {
        "model": MODEL,
        "max_tokens": 8192,
        "temperature": 0.3,
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
    expected = {item["vid"] for item in items}
    if {row.get("vid") for row in result} != expected:
        raise ValueError("vid mismatch")
    return result


def translate_batch(items: list[dict]) -> list[dict]:
    try:
        return call_gateway(items)
    except Exception as exc:  # noqa: BLE001 - split and retry
        if len(items) <= 1:
            print(f"    giving up on {items[0]['vid']}: {exc}")
            return []
        mid = len(items) // 2
        return translate_batch(items[:mid]) + translate_batch(items[mid:])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=int, default=12)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    with VIDEOS.open(encoding="utf-8") as fh:
        videos = [json.loads(line) for line in fh if line.strip()]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    done: set[str] = set()
    if OUT.exists():
        with OUT.open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    if row.get("title_zh") and row.get("summary_zh"):
                        done.add(row["vid"])
    todo = [v for v in videos if v["vid"] not in done]
    print(f"{len(videos)} videos, {len(done)} done, {len(todo)} to translate")

    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]
    written = 0
    with OUT.open("a", encoding="utf-8") as out:
        def work(batch: list[dict]) -> list[dict]:
            payload = [{"vid": v["vid"], "title": v.get("title", ""),
                        "summary": v.get("summary", ""), "why_hn": v.get("why_hn", "")}
                       for v in batch]
            return translate_batch(payload)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for index, rows in enumerate(pool.map(work, batches), 1):
                for row in rows:
                    out.write(json.dumps({
                        "vid": row["vid"],
                        "title_zh": row.get("title_zh", ""),
                        "summary_zh": row.get("summary_zh", ""),
                        "why_zh": row.get("why_zh", ""),
                    }, ensure_ascii=False) + "\n")
                written += len(rows)
                if index % 10 == 0 or index == len(batches):
                    out.flush()
                    print(f"  batch {index}/{len(batches)}, {written} translated")
                    time.sleep(0.2)

    print(f"done, {written} new records")


if __name__ == "__main__":
    main()
