#!/usr/bin/env python3
"""Classify hybrid-batch failures and emit a WeChat-friendly digest.

Reads the latest run's status.json plus the cumulative failed archive,
maps each failure's phase/error/reason onto a Chinese category with a
recommended action, and prints the digest. --push also uploads it to the
hermes gateway so the 3h WeChat report includes it.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "work" / "hybrid_batch" / "status.json"
ARCHIVE = ROOT / "work" / "batch_failed.txt"

# (reason substring, 分类, 处置建议) — first match wins.
RULES = (
    ("cloud request outcome uncertain", "Deepgram结果不确定", "等拍板 --retry-uncertain"),
    ("completion is unknown", "Deepgram结果未知", "同上,可能已计费"),
    ("English audio track not verified", "非英文内容被拦截", "任意语言字幕逻辑可救,下批重跑"),
    ("subtitle validation failed", "字幕过少验证不过", "视频内容稀疏,基本死案"),
    ("Translation incomplete", "翻译个别组被拒", "轻量重试可捞回"),
    ("video_unavailable", "视频不可用", "删除/私享,死案"),
    ("invalid or empty transcript", "Deepgram空转写", "可重试一次"),
    ("no usable captions", "无字幕且下载失败", "出口网络问题,可重试"),
    ("empty recognition", "空识别结果", "可重试"),
)


def classify(entry: dict) -> tuple[str, str]:
    """Map one failed status entry to (分类, 处置)."""
    reason = f"{entry.get('phase', '')} {entry.get('error_type', '')} {entry.get('reason', '')}"
    for needle, label, action in RULES:
        if needle in reason:
            return label, action
    return "未分类", reason.strip()[:60] or "见原始日志"


def digest() -> str:
    status = json.loads(STATUS.read_text(encoding="utf-8")) if STATUS.exists() else {}
    failed = {vid: v for vid, v in status.get("videos", {}).items()
              if v.get("status") == "failed"}
    archived = 0
    if ARCHIVE.exists():
        done = set(failed)
        archived = sum(1 for v in ARCHIVE.read_text(encoding="utf-8-sig").split()
                       if v and v not in done)
    lines = [f"🧯 失败分类(本轮{len(failed)}个 | 档案{archived}个)",
             f"── {datetime.now().strftime('%m-%d %H:%M')} ──"]
    buckets: dict[str, list[str]] = {}
    for vid, entry in failed.items():
        label, action = classify(entry)
        buckets.setdefault(label, []).append(f"{vid}({action})")
    for label, vids in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"▪ {label} ×{len(vids)}")
        for chunk in vids:
            lines.append(f"   {chunk}")
    return "\n".join(lines)


def push(text: str) -> None:
    subprocess.run(["scp", "-q", "-", "hermes:/home/ubuntu/.hermes/scripts/failure_digest.txt"],
                   input=text.encode("utf-8"), check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true",
                        help="also upload the digest to the hermes gateway")
    args = parser.parse_args()
    text = digest()
    print(text)
    if args.push:
        push(text)
        print(f"--- pushed to hermes ({datetime.now().strftime('%m-%d %H:%M')})")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
