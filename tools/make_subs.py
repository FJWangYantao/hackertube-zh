#!/usr/bin/env python3
"""Turn YouTube .vtt captions into translated cue JSON for the local site.

Reads work/subs/<vid>.en.vtt (falling back to .en-orig.vtt), groups the
cues into translation chunks, sends each chunk to the local magpie
gateway, and writes site/data/subs/<vid>.json.

Usage:
    python -I tools/make_subs.py --vids fNk_zzaMoSs JTfhYyTuT44
    python -I tools/make_subs.py --all
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBS_DIR = ROOT / "work" / "subs"
OUT_DIR = ROOT / "site" / "data" / "subs"
PICKED = ROOT / "work" / "picked.json"

GATEWAY = "http://127.0.0.1:3425/v1/chat/completions"
MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"
MAX_CHARS = 700          # per translation chunk
WORKERS = 4

SEP = "\n@@@\n"

SYSTEM = (
    "你是资深的英译中技术字幕译者，读者是中文开发者。"
    "用户给出若干句英文演讲字幕，句子之间用单独一行的 @@@ 分隔。"
    "请逐句译成简体中文，并且：\n"
    "1. 输出必须保留完全相同的 @@@ 分隔符，数量与顺序都要和输入一致；\n"
    "2. 不合并、不拆分句子，一句对应一句；\n"
    "3. 技术术语用中文通行译法，人名、产品名、项目名、代码标识保留英文；\n"
    "4. 口语化、简洁，适合字幕阅读；\n"
    "5. 只输出译文，不要解释、编号或代码块。"
)

GLOSSARY = (
    "术语参考：closure=闭包；garbage collection=垃圾回收；monad=单子；"
    "event loop=事件循环；backpropagation=反向传播；compiler=编译器；"
    "transformer=Transformer（保留英文）；thread=线程；runtime=运行时。"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# --- vtt parsing ----------------------------------------------------------

TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")
TAG = re.compile(r"<[^>]+>")


def parse_ts(value: str) -> float:
    match = TS.search(value)
    if not match:
        return 0.0
    hours, minutes, seconds, millis = match.groups()
    return (int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)
            + int(millis.ljust(3, "0")) / 1000)


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG.sub("", text))).strip()


def parse_vtt(path: Path) -> list[dict]:
    """Return cues as [{s, e, en}], collapsing YouTube's rolling captions."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    cues: list[dict] = []
    previous = ""
    for block in re.split(r"\n\s*\n", raw):
        lines = [line for line in block.strip().splitlines() if line.strip()]
        index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if index is None:
            continue
        start_raw, end_raw = lines[index].split("-->", 1)
        text = clean(" ".join(lines[index + 1:]))
        if not text:
            continue
        if previous and text.startswith(previous):
            text = text[len(previous):].strip()
        elif text == previous:
            text = ""
        previous = clean(" ".join(lines[index + 1:]))
        if text and not re.fullmatch(r"\[[^\]]*\]", text):
            cues.append({"s": parse_ts(start_raw), "e": parse_ts(end_raw), "en": text})
    return cues


def group_cues(cues: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    size = 0
    for cue in cues:
        current.append(cue)
        size += len(cue["en"])
        ends = bool(re.search(r"[.!?][\"')\]]?$", cue["en"]))
        if (size >= MAX_CHARS and ends) or size >= MAX_CHARS * 1.8:
            groups.append(current)
            current, size = [], 0
    if current:
        groups.append(current)
    return groups


# --- translation ----------------------------------------------------------

def call_gateway(sentences: list[str], timeout: int = 180) -> list[str]:
    body = {
        "model": MODEL,
        "max_tokens": 8192,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": GLOSSARY + "\n\n" + SEP.join(sentences)},
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
    content = re.sub(r"^```.*?$|```$", "", content, flags=re.M).strip()
    parts = [part.strip() for part in content.split("@@@")]
    if len(parts) != len(sentences):
        raise ValueError(f"separator mismatch: {len(parts)} vs {len(sentences)}")
    return parts


def translate_batch(sentences: list[str]) -> list[str]:
    """Translate in one call; split in half and retry on misalignment."""
    try:
        result = call_gateway(sentences)
        if all(result):
            return result
        raise ValueError("empty translation")
    except Exception:  # noqa: BLE001 - divide and retry
        if len(sentences) <= 1:
            return [""]
        mid = len(sentences) // 2
        return translate_batch(sentences[:mid]) + translate_batch(sentences[mid:])


def translate_group(group: list[dict]) -> list[dict]:
    sentences = [cue["en"] for cue in group]
    translated = translate_batch(sentences)
    return [{**cue, "zh": piece} for cue, piece in zip(group, translated)]


def build(vid: str, force: bool = False) -> bool:
    out_path = OUT_DIR / f"{vid}.json"
    if out_path.exists() and not force:
        print(f"  {vid}: already translated, skipped")
        return False
    source = next((SUBS_DIR / f"{vid}.{lang}.vtt" for lang in ("en", "en-orig")
                   if (SUBS_DIR / f"{vid}.{lang}.vtt").exists()
                   and (SUBS_DIR / f"{vid}.{lang}.vtt").stat().st_size > 500), None)
    if source is None:
        print(f"  {vid}: no vtt, skipped")
        return False
    cues = parse_vtt(source)
    if not cues:
        print(f"  {vid}: empty captions, skipped")
        return False
    groups = group_cues(cues)
    print(f"  {vid}: {len(cues)} cues -> {len(groups)} chunks ({source.name})")
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        translated = [cue for part in pool.map(translate_group, groups) for cue in part]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "vid": vid,
        "model": MODEL,
        "source": source.name,
        "cues": [{"s": round(c["s"], 2), "e": round(c["e"], 2),
                  "en": c["en"], "zh": c["zh"]} for c in translated],
    }
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    missing = sum(1 for c in translated if not c["zh"])
    print(f"  {vid}: wrote {len(translated)} cues, {missing} untranslated")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vids", nargs="*", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    vids = args.vids
    if args.all and PICKED.exists():
        vids = [item["vid"] for item in json.loads(PICKED.read_text(encoding="utf-8"))]
    if not vids:
        vids = sorted(p.stem.split(".")[0] for p in SUBS_DIR.glob("*.vtt"))

    done = 0
    for vid in dict.fromkeys(vids):
        try:
            done += build(vid, force=args.force)
        except Exception as exc:  # noqa: BLE001
            print(f"  {vid}: FAILED {exc}")
    print(f"built {done}/{len(set(vids))}")


if __name__ == "__main__":
    main()
