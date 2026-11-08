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
import functools
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
# `python -I` keeps the script directory off sys.path; the sibling modules we
# import by bare name (translation_backends) need it back.
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

ROOT = TOOLS_DIR.parent
SUBS_DIR = ROOT / "work" / "subs"
OUT_DIR = ROOT / "site" / "data" / "subs"
PICKED = ROOT / "work" / "picked.json"

GATEWAY = "http://127.0.0.1:3425/v1/chat/completions"
# 并行槽位：commandcode 80 + workbuddy cn 10 + workbuddy global 10，共 100 并发。
# antigravity 已撤下，空出的槽位全部并入 commandcode。
# 每块字幕落到哪个通道由 BackendPool 的空闲槽位决定，不经过 magpie 的组路由。
BACKEND_SLOTS: tuple[tuple[str, int], ...] = (
    ("commandcode-plan/deepseek/deepseek-v4.1-flash", 80),
    ("workbuddy-deepseek/cn:deepseek-v4.1-flash", 10),
    ("workbuddy-deepseek/global:deepseek-v4.1-flash-sg", 10),
)
MODEL = ""               # 空表示按 BACKEND_SLOTS 建池；--model 可覆盖为单通道
# 字幕翻译不需要思考链；开着会把 max_tokens 花在 reasoning_content 上。
REASONING_EFFORT = "none"
MAX_CHARS = 700          # per translation chunk
WORKERS = 4              # 仅单通道模式（--model）下生效

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
# YouTube's bridge cues are usually 10ms, but some tracks use 60ms.
BRIDGE_SECONDS = 0.10


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
    """Return cues as [{s, e, en}], collapsing YouTube's rolling captions.

    Auto-captions repeat the previous cue's last line as their first line,
    and insert 10ms bridge cues that repeat it again.
    """
    raw = path.read_text(encoding="utf-8", errors="replace")
    cues: list[dict] = []
    previous_line = ""
    saw_bridge = False
    for block in re.split(r"\r?\n\r?\n", raw):
        lines = [line for line in block.strip().splitlines() if line.strip()]
        index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if index is None:
            continue
        start_raw, end_raw = lines[index].split("-->", 1)
        start = parse_ts(start_raw)
        end = parse_ts(end_raw)
        if end - start <= BRIDGE_SECONDS:
            # YouTube emits 10ms cues that repeat the previous line.
            saw_bridge = True
            continue
        raw_text = "\n".join(lines[index + 1:])
        # Rolling auto-captions carry inline word timings (<c> tags) or bridge
        # cues; manual tracks have neither and may repeat a line on purpose.
        rolling = saw_bridge or "<c>" in raw_text
        text_lines = [clean(line) for line in lines[index + 1:]]
        text_lines = [line for line in text_lines if line]
        if rolling and previous_line and text_lines and text_lines[0] == previous_line:
            text_lines = text_lines[1:]
        saw_bridge = False
        if not text_lines:
            continue
        text = " ".join(text_lines)
        previous_line = text_lines[-1]
        if not re.fullmatch(r"\[[^\]]*\]", text):
            cues.append({"s": start, "e": end, "en": text})
    return cues


def group_cues(cues: list[dict], max_chars: int | None = None) -> list[list[dict]]:
    """Pack cues into translation requests; larger groups mean fewer round trips.

    Resolve the module-level MAX_CHARS at call time (not as a default argument),
    so main()'s --max-chars override actually takes effect.
    """
    if max_chars is None:
        max_chars = MAX_CHARS
    if type(max_chars) is not int or max_chars < 1:
        raise ValueError("max_chars must be a positive integer")
    groups: list[list[dict]] = []
    current: list[dict] = []
    size = 0
    for cue in cues:
        current.append(cue)
        size += len(cue["en"])
        ends = bool(re.search(r"[.!?][\"')\]]?$", cue["en"]))
        if (size >= max_chars and ends) or size >= max_chars * 1.8:
            groups.append(current)
            current, size = [], 0
    if current:
        groups.append(current)
    return groups


# --- translation ----------------------------------------------------------

def call_gateway(
    sentences: list[str], timeout: int = 180, attempts: int = 3, *, model: str | None = None,
    reasoning_effort: str | None = None, thinking: dict | None = None,
) -> list[str]:
    """Send a request using a local model choice, safe for mixed-model threads."""
    selected_model = MODEL if model is None else model
    if not selected_model and BACKEND_SLOTS:
        selected_model = BACKEND_SLOTS[0][0]
    if not isinstance(selected_model, str) or not selected_model.strip():
        raise ValueError("model must be a nonblank string")
    body = {
        "model": selected_model,
        "max_tokens": 8192,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": GLOSSARY + "\n\n" + SEP.join(sentences)},
        ],
    }
    if reasoning_effort is None and thinking is None:
        # 默认关闭思考链：字幕批量翻译不需要，开着既慢又容易把 max_tokens 吃光。
        reasoning_effort = REASONING_EFFORT
    if reasoning_effort:
        # Reasoning models (e.g. GLM-5.3-Flash) otherwise spend max_tokens on
        # reasoning_content and return an empty final answer.
        body["reasoning_effort"] = reasoning_effort
    if thinking is not None:
        # DeepSeek-style switch; upstreams that ignore it are unaffected.
        body["thinking"] = thinking
    request = urllib.request.Request(
        GATEWAY,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    payload = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
            break
        except urllib.error.HTTPError as error:
            # Quota and access errors will not recover within seconds; retrying
            # them only delays the pool's circuit breaker.
            if error.code in (402, 403) or attempt == attempts:
                raise
            time.sleep(1.5 * attempt)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == attempts:
                raise
            time.sleep(1.5 * attempt)
    content = payload["choices"][0]["message"]["content"].strip()
    content = re.sub(r"^```.*?$|```$", "", content, flags=re.M).strip()
    parts = [part.strip() for part in content.split("@@@")]
    if len(sentences) == 1 and len(parts) > 1:
        # A Whisper cue is often a whole paragraph; the model may answer with one
        # part per sentence. Every part still belongs to that single cue.
        parts = ["".join(part for part in parts if part)]
    if len(parts) != len(sentences):
        raise ValueError(f"separator mismatch: {len(parts)} vs {len(sentences)}")
    return parts


def make_transport(slots: tuple[tuple[str, int], ...], reasoning_effort: str | None = None):
    """Build the slot pool: every model owns its own concurrency budget.

    Each callback swallows content-level failures (separator mismatch, empty
    answer) by splitting the chunk and retrying, so only transport/quota errors
    reach the pool's circuit breaker. A formatting hiccup must never bench a
    healthy channel for 15 minutes.
    """
    from translation_backends import BackendPool, TranslationBackend
    effort = REASONING_EFFORT if reasoning_effort is None else reasoning_effort

    def upstream_kwargs(model: str) -> dict:
        """Close the thinking chain per upstream dialect.

        commandcode's DeepSeek accepts reasoning_effort=none; workbuddy's only
        offers low/high/max, so it needs the DeepSeek thinking switch instead —
        passing none there would silently land on "low", not off. Gemini has no
        off switch at all, so its nearest level is the best available.
        """
        if model.startswith("workbuddy-deepseek/"):
            return {"thinking": {"type": "disabled"}}
        if model.startswith("antigravity/"):
            return {"reasoning_effort": "low"}
        return {"reasoning_effort": effort}

    def callback(model: str):
        single = functools.partial(call_gateway, model=model, **upstream_kwargs(model))

        def translate(sentences: list[str]) -> list[str]:
            return translate_batch(sentences, single)

        return translate

    return BackendPool(tuple(
        TranslationBackend(model, count, callback(model))
        for model, count in slots
    ))


def transport_label(transport) -> str:
    """Short label for the subtitle JSON, e.g. 'deepseek-v4.1-flash+gemini-3.8-flash'."""
    models = getattr(transport, "models", None)
    if models:
        return "+".join(model.split("/")[-1] for model in models)
    return MODEL


def translate_batch(sentences: list[str], transport=None) -> list[str]:
    """Translate in one call; split in half and retry on misalignment."""
    send = call_gateway if transport is None else transport
    try:
        result = send(sentences)
        if all(result):
            return result
        raise ValueError("empty translation")
    except ValueError:
        # Misaligned or empty output: halve and retry. Network errors propagate
        # so a dead gateway fails the video instead of writing empty captions.
        if len(sentences) <= 1:
            return [""]
        mid = len(sentences) // 2
        return (translate_batch(sentences[:mid], transport)
                + translate_batch(sentences[mid:], transport))


def translate_group(group: list[dict], transport=None) -> list[dict]:
    sentences = [cue["en"] for cue in group]
    translated = translate_batch(sentences, transport)
    return [{**cue, "zh": piece} for cue, piece in zip(group, translated)]


def track_end(path: Path) -> float:
    cues = parse_vtt(path)
    return cues[-1]["e"] if cues else 0.0


def pick_source(vid: str) -> Path | None:
    """Pick the track that reaches furthest into the video.

    A manual ``en`` track sometimes only covers the opening seconds, while the
    auto-generated ``en-orig`` track has the whole talk; coverage beats order.
    """
    candidates = [
        SUBS_DIR / f"{vid}.{lang}.vtt"
        for lang in ("en", "en-orig")
        if (SUBS_DIR / f"{vid}.{lang}.vtt").exists()
        and (SUBS_DIR / f"{vid}.{lang}.vtt").stat().st_size > 500
    ]
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    ends = {path.name: track_end(path) for path in candidates}
    best = max(ends, key=ends.get)
    preferred = f"{vid}.en.vtt"
    # Only leave the cleaned track when it covers a small part of the video.
    if preferred in ends and ends[preferred] >= ends[best] * 0.8:
        return SUBS_DIR / preferred
    return SUBS_DIR / best


def write_payload(vid: str, source: Path, translated: list[dict], label: str) -> None:
    payload = {
        "vid": vid,
        "model": label,
        "source": source.name,
        "cues": [{"s": round(c["s"], 2), "e": round(c["e"], 2),
                  "zh": c["zh"], "en": c["en"]} for c in translated],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with (OUT_DIR / f"{vid}.json").open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)


def build(vid: str, force: bool = False, transport=None) -> bool:
    """Translate one video; returns True when a file was written."""
    return build_many([vid], transport=transport, force=force) == 1


def build_many(vids: list[str], transport=None, force: bool = False) -> int:
    """Translate several videos through one shared slot pool.

    Chunks from every video are queued together, so a short video no longer
    leaves most of the 30 slots idle while its own dozen chunks finish.
    """
    if transport is None:
        transport = make_transport(BACKEND_SLOTS)
    label = transport_label(transport)

    sources: dict[str, Path] = {}
    grouped: dict[str, list[list[dict]]] = {}
    tasks: list[tuple[str, int]] = []
    for vid in dict.fromkeys(vids):
        if (OUT_DIR / f"{vid}.json").exists() and not force:
            print(f"  {vid}: already translated, skipped", flush=True)
            continue
        source = pick_source(vid)
        if source is None:
            print(f"  {vid}: no vtt, skipped", flush=True)
            continue
        cues = parse_vtt(source)
        if not cues:
            print(f"  {vid}: empty captions, skipped", flush=True)
            continue
        groups = group_cues(cues)
        sources[vid] = source
        grouped[vid] = groups
        tasks.extend((vid, index) for index in range(len(groups)))
        print(f"  {vid}: {len(cues)} cues -> {len(groups)} chunks ({source.name})",
              flush=True)

    if not tasks:
        return 0

    results: dict[str, list] = {vid: [None] * len(groups)
                                for vid, groups in grouped.items()}
    remaining: dict[str, int] = {vid: len(groups) for vid, groups in grouped.items()}
    failures: dict[str, Exception] = {}
    built = 0

    def finalize(vid: str) -> None:
        """Write a video the moment its last chunk lands, so progress survives."""
        nonlocal built
        if vid in failures:
            print(f"  {vid}: FAILED {failures[vid]}", flush=True)
            return
        translated = [cue for part in results[vid] if part for cue in part]
        missing = sum(1 for c in translated if not c["zh"])
        if translated and missing == len(translated):
            print(f"  {vid}: FAILED all cues untranslated", flush=True)
            return
        write_payload(vid, sources[vid], translated, label)
        built += 1
        print(f"  {vid}: wrote {len(translated)} cues, {missing} untranslated "
              f"({built}/{len(grouped)})", flush=True)

    concurrency = getattr(transport, "workers", WORKERS)
    print(f"  queueing {len(tasks)} chunks over {concurrency} slots...", flush=True)
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(translate_group, grouped[vid][index], transport): (vid, index)
            for vid, index in tasks
        }
        for future in as_completed(futures):
            vid, index = futures[future]
            try:
                results[vid][index] = future.result()
            except Exception as exc:  # noqa: BLE001
                failures.setdefault(vid, exc)
            remaining[vid] -= 1
            if remaining[vid] == 0:
                finalize(vid)

    return built


def parse_slots(spec: str) -> tuple[tuple[str, int], ...]:
    """Parse 'model=n,model=n' into slot pairs."""
    slots: list[tuple[str, int]] = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        model, sep, count = item.rpartition("=")
        if not sep or not model or not count.isdigit() or int(count) < 1:
            raise ValueError(f"bad slot spec {item!r}; expected model=n")
        slots.append((model, int(count)))
    if not slots:
        raise ValueError("empty --slots")
    return tuple(slots)


def main() -> None:
    global WORKERS, MODEL, MAX_CHARS, REASONING_EFFORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--vids", nargs="*", default=[])
    parser.add_argument("--vid-file", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--workers", type=int, default=WORKERS,
                        help="仅单通道模式（--model）下生效")
    parser.add_argument("--model", default=MODEL,
                        help="单通道模型；给出时忽略 --slots")
    parser.add_argument("--slots", default="",
                        help="并行槽位，如 'model=20,model=10'；默认 "
                             + ",".join(f"{m}={n}" for m, n in BACKEND_SLOTS))
    parser.add_argument("--max-chars", type=int, default=MAX_CHARS)
    parser.add_argument("--limit", type=int, default=0,
                        help="只处理前 N 个尚未翻译的视频（分批推进用）")
    parser.add_argument("--reasoning-effort", default=REASONING_EFFORT,
                        help="传给上游的 reasoning_effort；空字符串表示不传")
    args = parser.parse_args()
    WORKERS = max(1, args.workers)
    MODEL = args.model
    MAX_CHARS = max(200, args.max_chars)
    REASONING_EFFORT = args.reasoning_effort

    slots = (tuple([(args.model, WORKERS)]) if args.model
             else parse_slots(args.slots) if args.slots
             else BACKEND_SLOTS)
    transport = make_transport(slots)
    print("pool: " + ", ".join(f"{m} x{n}" for m, n in slots)
          + f" = {transport.workers} 并发", flush=True)

    vids = args.vids
    if args.vid_file:
        vids = Path(args.vid_file).read_text(encoding="utf-8").split()
        if not vids:
            print(f"empty --vid-file: {args.vid_file}")
            return
    if args.all and PICKED.exists():
        vids = [item["vid"] for item in json.loads(PICKED.read_text(encoding="utf-8"))]
    if not vids:
        vids = sorted(p.stem.split(".")[0] for p in SUBS_DIR.glob("*.vtt"))

    vids = list(dict.fromkeys(vids))
    if args.limit and not args.force:
        # Skip what is already on disk first, so a batch always makes progress.
        vids = [vid for vid in vids if not (OUT_DIR / f"{vid}.json").exists()][:args.limit]
    done = build_many(vids, transport=transport, force=args.force)
    print(f"built {done}/{len(vids)}")


if __name__ == "__main__":
    main()
