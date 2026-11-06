#!/usr/bin/env python3
"""Read-only HTTP & JSON API server for the live HackerTube translation pipeline.

Serves reports/translation-pipeline.html at / and exposes real-time read-only
endpoints backed directly by the repository's data/, work/, and site/ files,
plus the live tools/ verification and gateway functions.

Usage:
    python -I tools/pipeline_server.py --port 8767
"""

from __future__ import annotations

import argparse
import collections
import json
import mimetypes
import re
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import check_subs as cs  # noqa: E402
import make_subs as ms  # noqa: E402
import subtitle_recovery as sr  # noqa: E402
import transcribe_gemini as tg  # noqa: E402
import translation_backends as tb  # noqa: E402

DATA_DIR = ROOT / "data"
WORK_DIR = ROOT / "work"
SITE_DIR = ROOT / "site"
SUBS_OUT_DIR = SITE_DIR / "data" / "subs"
COMMENTS_OUT_DIR = SITE_DIR / "data" / "comments"
VTT_DIR = WORK_DIR / "subs"
AUDIO_DIR = WORK_DIR / "audio"
WHISPER_BATCH_DIR = WORK_DIR / "whisper_batch"
STATUS_PATH = WHISPER_BATCH_DIR / "status.json"
HYBRID_DIR = WORK_DIR / "hybrid_batch"
HYBRID_STATUS_PATH = HYBRID_DIR / "status.json"
HYBRID_PHASES = {
    "recognizing": "recognition",
    "translating": "translation",
    "completed": "completed",
    "failed": "failed",
}
HTML_PATH = ROOT / "reports" / "translation-pipeline.html"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_text_safe(path: Path, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            if attempt + 1 == retries:
                raise
            time.sleep(0.025)
    return ""


def read_json_safe(path: Path, default: Any = None, retries: int = 3) -> Any:
    if not path.exists():
        return default
    for attempt in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            if attempt + 1 == retries:
                return default
            time.sleep(0.025)
    return default


# --- Cached static indexes (auto-refreshed when files change) -------------

_STATIC_CACHE: dict[str, Any] = {}


def get_video_catalog() -> dict[str, dict[str, Any]]:
    """Return vid -> merged metadata from data/videos.jsonl and work/videos_zh.jsonl."""
    vpath = DATA_DIR / "videos.jsonl"
    zhpath = WORK_DIR / "videos_zh.jsonl"
    key = (
        vpath.stat().st_mtime if vpath.exists() else 0,
        zhpath.stat().st_mtime if zhpath.exists() else 0,
    )
    if _STATIC_CACHE.get("catalog_key") == key:
        return _STATIC_CACHE["catalog"]

    catalog: dict[str, dict[str, Any]] = {}
    if vpath.exists():
        for line in read_text_safe(vpath).splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            vid = row["vid"]
            catalog[vid] = {
                "vid": vid,
                "title": row.get("title", ""),
                "channel": row.get("channel", ""),
                "score": float(row.get("score") or 0),
                "shelf_life": row.get("shelf_life", ""),
                "content_type": row.get("content_type", ""),
                "summary": row.get("summary", ""),
                "why_hn": row.get("why_hn", ""),
                "hn_mentions": (row.get("hn") or {}).get("mentions", 0),
                "areas": [t.get("area") for t in (row.get("topics") or []) if t.get("area")],
            }
    zh_rows = 0
    if zhpath.exists():
        for line in read_text_safe(zhpath).splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            zh_rows += 1
            vid = row.get("vid")
            if vid in catalog:
                catalog[vid]["title_zh"] = row.get("title_zh", "")
                catalog[vid]["summary_zh"] = row.get("summary_zh", "")
                catalog[vid]["why_zh"] = row.get("why_zh", "")
    _STATIC_CACHE["catalog_key"] = key
    _STATIC_CACHE["catalog"] = catalog
    _STATIC_CACHE["zh_rows"] = zh_rows
    return catalog


def get_subs_index() -> dict[str, Any]:
    """Scan site/data/subs/*.json with per-file mtime caching."""
    cache: dict[str, dict[str, Any]] = _STATIC_CACHE.setdefault("subs_files", {})
    current_paths = list(SUBS_OUT_DIR.glob("*.json")) if SUBS_OUT_DIR.exists() else []
    current_names = {p.stem for p in current_paths}
    for gone in list(cache.keys()):
        if gone not in current_names:
            cache.pop(gone, None)

    for path in current_paths:
        vid = path.stem
        try:
            mtime = path.stat().st_mtime
            size = path.stat().st_size
        except OSError:
            continue
        cached = cache.get(vid)
        if cached and cached.get("mtime") == mtime:
            continue
        data = read_json_safe(path)
        if not isinstance(data, dict):
            continue
        cues = data.get("cues") or []
        source = str(data.get("source") or "")
        if source.endswith(".en-orig.vtt"):
            source_kind = "vtt-auto"
        elif source.endswith(".vtt"):
            source_kind = "vtt-manual"
        elif source == "gemini":
            source_kind = "gemini"
        elif source == "whisper-local":
            source_kind = "whisper-local"
        else:
            source_kind = source or "unknown"
        span = (cues[-1]["e"] - cues[0]["s"]) if cues else 0.0
        zh_chars = sum(len(str(c.get("zh") or "")) for c in cues)
        en_words = sum(len(str(c.get("en") or "").split()) for c in cues)
        cache[vid] = {
            "vid": vid,
            "mtime": mtime,
            "size": size,
            "source": source,
            "source_kind": source_kind,
            "model": data.get("model"),
            "translation_model": data.get("translation_model"),
            "translation_models": data.get("translation_models"),
            "translation_workers": data.get("translation_workers"),
            "cue_count": len(cues),
            "span": round(span, 2),
            "end": round(cues[-1]["e"], 2) if cues else 0.0,
            "zh_chars": zh_chars,
            "en_words": en_words,
        }
    return cache


def get_comments_summary() -> dict[str, Any]:
    cache: dict[str, dict[str, Any]] = _STATIC_CACHE.setdefault("comment_files", {})
    paths = list(COMMENTS_OUT_DIR.glob("*.json")) if COMMENTS_OUT_DIR.exists() else []
    for path in paths:
        vid = path.stem
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if vid in cache and cache[vid]["mtime"] == mtime:
            continue
        data = read_json_safe(path)
        if not isinstance(data, dict):
            continue
        rows = data.get("comments") or []
        stances = collections.Counter(r.get("stance", "") for r in rows)
        blank = sum(1 for r in rows if not str(r.get("text_zh") or "").strip())
        cache[vid] = {
            "vid": vid,
            "mtime": mtime,
            "count": len(rows),
            "blank": blank,
            "stances": dict(stances),
        }
    total_comments = sum(v["count"] for v in cache.values())
    total_blank = sum(v["blank"] for v in cache.values())
    stance_totals: collections.Counter[str] = collections.Counter()
    for v in cache.values():
        stance_totals.update(v["stances"])
    return {
        "files": len(cache),
        "total_comments": total_comments,
        "blank_comments": total_blank,
        "stances": dict(stance_totals),
    }


def parse_runner_log(log_text: str) -> dict[str, Any]:
    lines = [line.strip() for line in log_text.splitlines() if line.strip()]
    recognized_segments = 0
    recognized_audio_pos = 0.0
    duration = 0.0
    vad_removed = ""
    trimmed_overlaps = 0
    device_info = ""
    staged_cues = 0
    for line in lines:
        m = re.search(r"loading (\S+) on (\S+)", line)
        if m:
            device_info = f"{m.group(1)} @ {m.group(2)}"
        m = re.search(r"starting Batched Whisper for \S+ \(([\d.]+)s\)", line)
        if m:
            duration = float(m.group(1))
        m = re.search(r"VAD filter removed (\S+) of audio", line)
        if m:
            vad_removed = m.group(1)
        m = re.search(r"recognized (\d+) segments, audio position ([\d.]+)s", line)
        if m:
            recognized_segments = int(m.group(1))
            recognized_audio_pos = float(m.group(2))
        m = re.search(r"language=\S+, duration=([\d.]+)s, segments=(\d+)", line)
        if m:
            duration = float(m.group(1))
            recognized_segments = int(m.group(2))
            recognized_audio_pos = duration
        m = re.search(r"trimmed (\d+) overlapping", line)
        if m:
            trimmed_overlaps = int(m.group(1))
        m = re.search(r"STAGED SUBTITLE (\d+) cues", line)
        if m:
            staged_cues = int(m.group(1))
    return {
        "device_info": device_info,
        "duration": duration,
        "vad_removed": vad_removed,
        "recognized_segments": recognized_segments,
        "recognized_audio_pos": recognized_audio_pos,
        "trimmed_overlaps": trimmed_overlaps,
        "staged_cues": staged_cues,
        "lines": lines[-40:],
    }


def inspect_whisper_stage(vid: str) -> dict[str, Any]:
    """Read live stage artifacts for a video in work/whisper_batch/<vid>."""
    stage = WHISPER_BATCH_DIR / vid
    if not stage.is_dir():
        return {"vid": vid, "exists": False}

    lock_path = stage / "runner.lock"
    lock_info = read_json_safe(lock_path) if lock_path.exists() else None
    state = read_json_safe(stage / "runner_state.json", default={})

    logs = sorted(stage.glob("runner_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    log_info = {"lines": []}
    latest_log_name = None
    if logs:
        latest_log_name = logs[0].name
        log_info = parse_runner_log(read_text_safe(logs[0]))

    transcript_path = stage / "transcript.json"
    transcript = read_json_safe(transcript_path, default=[]) if transcript_path.exists() else []
    cues_input = [
        {"s": float(r["start"]), "e": float(r["end"]), "en": str(r["text"]).strip()}
        for r in transcript
        if isinstance(r, dict) and r.get("text")
    ]
    groups = ms.group_cues(cues_input, max_chars=2500) if cues_input else []

    ck_files = sorted(
        stage.glob("translation_checkpoint*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    ck_data = read_json_safe(ck_files[0], default={}) if ck_files else {}
    translations: dict[str, str] = (
        ck_data.get("translations") if isinstance(ck_data, dict) and isinstance(ck_data.get("translations"), dict) else {}
    )
    ck_mtime = ck_files[0].stat().st_mtime if ck_files else None

    # Map each group to its completion state
    group_states = []
    offset = 0
    for g_idx, g in enumerate(groups):
        idxs = list(range(offset, offset + len(g)))
        done_idxs = [i for i in idxs if str(i) in translations]
        chars = sum(len(c["en"]) for c in g)
        group_states.append({
            "group_index": g_idx,
            "start_cue": idxs[0] if idxs else 0,
            "end_cue": idxs[-1] if idxs else 0,
            "total": len(idxs),
            "done": len(done_idxs),
            "chars": chars,
            "s": round(g[0]["s"], 2) if g else 0,
            "e": round(g[-1]["e"], 2) if g else 0,
        })
        offset += len(g)

    # Build cue preview list (with live translations attached)
    cue_rows = []
    for idx, c in enumerate(cues_input):
        zh = translations.get(str(idx), "")
        issue = sr.translation_issue(zh, c["en"]) if zh else None
        words = transcript[idx].get("words") or [] if idx < len(transcript) else []
        cue_rows.append({
            "i": idx,
            "s": round(c["s"], 2),
            "e": round(c["e"], 2),
            "en": c["en"],
            "zh": zh,
            "done": bool(zh),
            "issue": issue,
            "word_count": len(words),
            "words_head": [
                {"w": w.get("word"), "s": round(float(w.get("start", 0)), 2), "p": round(float(w.get("probability", 0)), 3)}
                for w in words[:8]
            ],
        })

    # Audio metadata summary (fast check without re-parsing 500KB unless needed)
    info_path = stage / "english_audio" / "audio.info.json"
    audio_files = [
        p.name for p in (stage / "english_audio").glob("*")
        if p.suffix.lower() in tg.AUDIO_SUFFIXES
    ] if (stage / "english_audio").is_dir() else []

    return {
        "vid": vid,
        "exists": True,
        "locked": lock_info is not None,
        "lock": lock_info,
        "runner_state": state,
        "log_file": latest_log_name,
        "log": log_info,
        "audio_files": audio_files,
        "has_audio_info": info_path.exists(),
        "transcript_count": len(cues_input),
        "checkpoint_file": ck_files[0].name if ck_files else None,
        "checkpoint_mtime": ck_mtime,
        "checkpoint_model": ck_data.get("model") if isinstance(ck_data, dict) else None,
        "checkpoint_fingerprint": ck_data.get("fingerprint") if isinstance(ck_data, dict) else None,
        "translated_count": len(translations),
        "groups": group_states,
        "cues": cue_rows,
        "has_staged_subtitle": (stage / "subtitle.json").exists(),
        "is_published": (SUBS_OUT_DIR / f"{vid}.json").exists(),
    }


def summarize_recognition(
    rows: Any, translations: dict[str, str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build group completion and cue preview rows from normalized ASR rows."""
    cues: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("text"), str):
            continue
        if not row["text"].strip():
            continue
        try:
            cues.append(({"s": float(row["start"]), "e": float(row["end"]),
                          "en": row["text"].strip()}, row))
        except (KeyError, TypeError, ValueError):
            continue
    groups = ms.group_cues([cue for cue, _ in cues], max_chars=2500) if cues else []
    group_states = []
    offset = 0
    for g_idx, group in enumerate(groups):
        indexes = list(range(offset, offset + len(group)))
        group_states.append({
            "group_index": g_idx,
            "start_cue": indexes[0] if indexes else 0,
            "end_cue": indexes[-1] if indexes else 0,
            "total": len(indexes),
            "done": sum(1 for i in indexes if str(i) in translations),
            "chars": sum(len(cue["en"]) for cue in group),
            "s": round(group[0]["s"], 2) if group else 0,
            "e": round(group[-1]["e"], 2) if group else 0,
        })
        offset += len(group)
    cue_rows = []
    for idx, (cue, row) in enumerate(cues):
        zh = translations.get(str(idx), "")
        words = row.get("words") if isinstance(row.get("words"), list) else []
        cue_rows.append({
            "i": idx,
            "s": round(cue["s"], 2),
            "e": round(cue["e"], 2),
            "en": cue["en"],
            "zh": zh,
            "done": bool(zh),
            "issue": sr.translation_issue(zh, cue["en"]) if zh else None,
            "word_count": len(words),
            "words_head": [
                {"w": w.get("word"), "s": round(float(w.get("start", 0)), 2),
                 "p": round(float(w.get("probability", 0)), 3)}
                for w in words[:8] if isinstance(w, dict)
            ],
        })
    return group_states, cue_rows


def inspect_hybrid_stage(vid: str, event: dict[str, Any] | None = None) -> dict[str, Any]:
    """Read live hybrid-batch artifacts for one video."""
    stage = HYBRID_DIR / vid
    if not stage.is_dir():
        return {"vid": vid, "exists": False, "engine": "hybrid"}
    event = event or {}
    lock_path = HYBRID_DIR / "batch.lock"
    lock_info = read_json_safe(lock_path) if lock_path.exists() else None

    recognition = read_json_safe(stage / "recognition.json", default={})
    if not isinstance(recognition, dict):
        recognition = {}
    rows = recognition.get("rows") if isinstance(recognition.get("rows"), list) else []

    checkpoints = sorted(stage.glob("translation.*.json"),
                         key=lambda p: p.stat().st_mtime, reverse=True)
    checkpoint = read_json_safe(checkpoints[0], default={}) if checkpoints else {}
    if not isinstance(checkpoint, dict):
        checkpoint = {}
    translations = checkpoint.get("translations")
    if not isinstance(translations, dict):
        translations = {}

    groups, cues = summarize_recognition(rows, translations)
    status = str(event.get("status") or "")
    provider = str(event.get("provider") or recognition.get("source") or "")
    model = str(recognition.get("model") or "")
    raw_duration = recognition.get("duration")
    duration = float(raw_duration) if type(raw_duration) in (int, float) else 0.0
    phase = str(event.get("phase") or HYBRID_PHASES.get(status, status or "idle"))
    lines = [
        f"engine=hybrid status={status or 'idle'} phase={phase}",
        f"provider={provider or '—'} model={model or '—'} duration={duration:.1f}s",
        f"recognition rows={len(rows)} groups={len(groups)} translated={len(translations)}",
    ]
    return {
        "vid": vid,
        "exists": True,
        "engine": "hybrid",
        "locked": lock_info is not None,
        "lock": lock_info,
        "runner_state": {
            "status": status or "idle",
            "phase": phase,
            "provider": provider,
            "cues": len(rows),
            "workers": None,
        },
        "log_file": "recognition.json",
        "log": {
            "device_info": " · ".join(part for part in (provider, model) if part),
            "duration": duration,
            "recognized_audio_pos": duration if rows else 0.0,
            "recognized_segments": len(rows),
            "lines": lines,
        },
        "audio_files": [],
        "transcript_count": len(rows),
        "checkpoint_file": checkpoints[0].name if checkpoints else None,
        "checkpoint_mtime": checkpoints[0].stat().st_mtime if checkpoints else None,
        "checkpoint_model": checkpoint.get("model"),
        "checkpoint_fingerprint": checkpoint.get("fingerprint"),
        "translated_count": len(translations),
        "groups": groups,
        "cues": cues,
        "has_staged_subtitle": (stage / "subtitle.json").exists(),
        "is_published": (SUBS_OUT_DIR / f"{vid}.json").exists(),
    }


def hybrid_video_events() -> dict[str, dict[str, Any]]:
    payload = read_json_safe(HYBRID_STATUS_PATH, default={})
    videos = payload.get("videos") if isinstance(payload, dict) else None
    if not isinstance(videos, dict):
        return {}
    return {str(key): value for key, value in videos.items() if isinstance(value, dict)}


def build_live_payload(target_vid: str | None = None) -> dict[str, Any]:
    catalog = get_video_catalog()
    hybrid_payload = read_json_safe(HYBRID_STATUS_PATH, default={})
    if not isinstance(hybrid_payload, dict):
        hybrid_payload = {}
    hybrid_videos = hybrid_video_events()
    engine = "hybrid" if hybrid_videos else "whisper_batch"
    status_map: dict[str, dict[str, Any]] = hybrid_videos or read_json_safe(STATUS_PATH, default={})
    batch_ids = []
    for batch_file in ("batch_next.txt", "batch200_new.txt", "batch200.txt"):
        p = WORK_DIR / batch_file
        if p.exists():
            batch_ids = list(dict.fromkeys(read_text_safe(p).split()))
            break

    # Find currently running video
    active_vid = target_vid
    if not active_vid:
        for vid, st in reversed(list(status_map.items())):
            if st.get("status") in ("processing", "downloading", "verifying",
                                    "recognizing", "translating"):
                active_vid = vid
                break
    if not active_vid and engine == "whisper_batch" and WHISPER_BATCH_DIR.exists():
        # Check for any live runner.lock
        locks = list(WHISPER_BATCH_DIR.glob("*/runner.lock"))
        if locks:
            active_vid = locks[0].parent.name
    if not active_vid and status_map:
        active_vid = next(reversed(status_map))

    if engine == "hybrid":
        stage_detail = (inspect_hybrid_stage(active_vid, status_map.get(active_vid, {}))
                        if active_vid else {"exists": False, "engine": "hybrid"})
    else:
        stage_detail = inspect_whisper_stage(active_vid) if active_vid else {"exists": False}

    # Summarize status.json entries (newest last)
    raw_counts = collections.Counter(v.get("status", "unknown") for v in status_map.values())
    status_counts = dict(raw_counts)
    status_counts["processing"] = raw_counts.get("recognizing", 0) + raw_counts.get("translating", 0)
    recent_items = []
    for vid, st in list(status_map.items())[-30:]:
        meta = catalog.get(vid, {})
        recent_items.append({
            "vid": vid,
            "title": meta.get("title_zh") or meta.get("title") or vid,
            "title_en": meta.get("title") or vid,
            "channel": meta.get("channel", ""),
            "score": meta.get("score", 0),
            "status": st.get("status"),
            "phase": st.get("phase") or st.get("provider"),
            "duration": st.get("duration"),
            "reason": st.get("reason"),
            "log_path": st.get("log_path"),
            "published": (SUBS_OUT_DIR / f"{vid}.json").exists(),
        })

    # Find next pending videos in batch_ids
    next_pending = []
    for vid in batch_ids:
        if vid not in status_map and not (SUBS_OUT_DIR / f"{vid}.json").exists():
            meta = catalog.get(vid, {})
            has_prefetched = (WHISPER_BATCH_DIR / vid / "english_audio" / "audio.info.json").exists()
            next_pending.append({
                "vid": vid,
                "title": meta.get("title_zh") or meta.get("title") or vid,
                "channel": meta.get("channel", ""),
                "score": meta.get("score", 0),
                "prefetched": has_prefetched,
            })
            if len(next_pending) >= 12:
                break

    active_meta = catalog.get(active_vid or "", {})
    latest = hybrid_payload.get("latest") if isinstance(hybrid_payload.get("latest"), dict) else {}
    try:
        hybrid_updated = HYBRID_STATUS_PATH.stat().st_mtime
    except OSError:
        hybrid_updated = None
    return {
        "now": time.time(),
        "engine": engine,
        "active_vid": active_vid,
        "active_meta": active_meta,
        "active_status": status_map.get(active_vid or "", {}),
        "stage": stage_detail,
        "batch_total_tracked": len(status_map),
        "batch_status_counts": status_counts,
        "recent_items": list(reversed(recent_items)),
        "next_pending": next_pending,
        "published_subs_total": len(list(SUBS_OUT_DIR.glob("*.json"))) if SUBS_OUT_DIR.exists() else 0,
        "hybrid": {
            "configured": bool(hybrid_videos),
            "configuration": hybrid_payload.get("configuration"),
            "active_vids": hybrid_payload.get("active_vids") or [],
            "translation_active": latest.get("translation_active"),
            "backlog_groups": latest.get("backlog_groups"),
            "asr_active": latest.get("asr_active"),
            "latest_event": latest.get("event"),
            "paused": latest.get("paused") if latest.get("event") == "admission" else None,
            "updated": hybrid_updated,
        },
    }


def build_overview_payload() -> dict[str, Any]:
    catalog = get_video_catalog()
    subs_idx = get_subs_index()
    com_sum = get_comments_summary()
    status_map: dict[str, dict[str, Any]] = read_json_safe(STATUS_PATH, default={})
    hybrid_raw = read_json_safe(HYBRID_STATUS_PATH, default={})
    hybrid_videos = hybrid_raw.get("videos") if isinstance(hybrid_raw, dict) else None
    if not isinstance(hybrid_videos, dict):
        hybrid_videos = {}

    by_source = collections.Counter(v["source_kind"] for v in subs_idx.values())
    cues_by_source: collections.Counter[str] = collections.Counter()
    by_model: collections.Counter[str] = collections.Counter()
    total_cues = 0
    total_zh_chars = 0
    total_en_words = 0
    for v in subs_idx.values():
        cues_by_source[v["source_kind"]] += v["cue_count"]
        total_cues += v["cue_count"]
        total_zh_chars += v["zh_chars"]
        total_en_words += v["en_words"]
        m = v["translation_model"] or v["model"] or "unknown"
        by_model[str(m)] += 1

    vtt_en = len(list(VTT_DIR.glob("*.en.vtt"))) if VTT_DIR.exists() else 0
    vtt_orig = len(list(VTT_DIR.glob("*.en-orig.vtt"))) if VTT_DIR.exists() else 0
    gem_caches = len(list(AUDIO_DIR.glob("*.gemini.json"))) if AUDIO_DIR.exists() else 0
    wh_caches = len(list(AUDIO_DIR.glob("*.whisper.json"))) if AUDIO_DIR.exists() else 0

    evergreen = sum(1 for v in catalog.values() if v.get("shelf_life") != "news")
    news_count = len(catalog) - evergreen
    meta_done = sum(1 for v in catalog.values() if v.get("title_zh") and v.get("summary_zh"))

    block_path = ROOT / "tools" / "blocklist.txt"
    blocked_areas, blocked_vids = [], []
    if block_path.exists():
        for raw in read_text_safe(block_path).splitlines():
            token = raw.split("#", 1)[0].strip()
            if not token:
                continue
            if token.startswith("area:"):
                blocked_areas.append(token[5:].strip())
            else:
                blocked_vids.append(token)

    return {
        "now": time.time(),
        "videos": {
            "total": len(catalog),
            "evergreen": evergreen,
            "news": news_count,
            "meta_translated": meta_done,
            "videos_zh_lines": _STATIC_CACHE.get("zh_rows", meta_done),
            "blocked_areas": blocked_areas,
            "blocked_vids_count": len(blocked_vids),
        },
        "comments": com_sum,
        "work_caches": {
            "vtt_en": vtt_en,
            "vtt_en_orig": vtt_orig,
            "vtt_total": vtt_en + vtt_orig,
            "gemini_json": gem_caches,
            "whisper_json": wh_caches,
        },
        "subs": {
            "files": len(subs_idx),
            "total_cues": total_cues,
            "total_zh_chars": total_zh_chars,
            "total_en_words": total_en_words,
            "by_source_files": dict(by_source),
            "by_source_cues": dict(cues_by_source),
            "by_model": dict(by_model.most_common()),
        },
        "whisper_batch": {
            "tracked": len(status_map),
            "counts": dict(collections.Counter(v.get("status", "unknown") for v in status_map.values())),
        },
        "hybrid_batch": {
            "configured": bool(hybrid_videos),
            "tracked": len(hybrid_videos),
            "counts": dict(collections.Counter(
                v.get("status", "unknown") for v in hybrid_videos.values() if isinstance(v, dict))),
            "configuration": hybrid_raw.get("configuration") if isinstance(hybrid_raw, dict) else None,
        },
        "config": {
            "gateway": ms.GATEWAY,
            "default_model": ms.MODEL,
            "vtt_max_chars": ms.MAX_CHARS,
            "whisper_max_chars": 2500,
            "bridge_seconds": ms.BRIDGE_SECONDS,
            "gemini_model": tg.DEFAULT_MODEL,
            "gemini_chunk_seconds": tg.CHUNK_SECONDS,
            "gemini_min_chunk_seconds": tg.MIN_CHUNK_SECONDS,
            "antigravity_model": tb.ANTIGRAVITY_MODEL,
            "antigravity_workers": tb.MAX_ANTIGRAVITY_WORKERS,
            "deepseek_model": tb.DEEPSEEK_CN_MODEL,
            "deepseek_workers": tb.MAX_DEEPSEEK_WORKERS,
            "max_chars_per_second": cs.MAX_CHARS_PER_SECOND,
            "translation_ratio": sr.TRANSLATION_RATIO,
        },
    }


def build_video_trace(vid: str) -> dict[str, Any]:
    """Deep pipeline inspection for a specific video ID across all stages."""
    catalog = get_video_catalog()
    meta = catalog.get(vid, {"vid": vid})

    # 1. VTT files & parse_vtt / pick_source trace
    vtt_candidates = []
    for lang in ("en", "en-orig"):
        p = VTT_DIR / f"{vid}.{lang}.vtt"
        if p.exists():
            cues = ms.parse_vtt(p)
            raw_head = read_text_safe(p)[:2200]
            vtt_candidates.append({
                "name": p.name,
                "lang": lang,
                "size": p.stat().st_size,
                "cue_count": len(cues),
                "end": round(cues[-1]["e"], 2) if cues else 0.0,
                "has_c_tags": "<c>" in raw_head,
                "raw_sample": raw_head[:1200],
            })
    picked_vtt = ms.pick_source(vid)
    vtt_groups_summary = None
    if picked_vtt and picked_vtt.exists():
        parsed_cues = ms.parse_vtt(picked_vtt)
        groups = ms.group_cues(parsed_cues, max_chars=ms.MAX_CHARS)
        vtt_groups_summary = {
            "picked": picked_vtt.name,
            "parsed_cues": len(parsed_cues),
            "chunk_count": len(groups),
            "chunks_preview": [
                {
                    "idx": i,
                    "cues": len(g),
                    "chars": sum(len(c["en"]) for c in g),
                    "s": round(g[0]["s"], 2),
                    "e": round(g[-1]["e"], 2),
                    "last_en": g[-1]["en"][-60:],
                }
                for i, g in enumerate(groups[:24])
            ],
        }

    # 2. Gemini transcript cache
    gem_path = AUDIO_DIR / f"{vid}.gemini.json"
    gemini_info = None
    if gem_path.exists():
        segs = read_json_safe(gem_path, default=[])
        cues = tg.segments_to_cues(segs) if isinstance(segs, list) else []
        text_sample = " ".join(c["en"] for c in cues[:200])
        letters = re.findall(r"[^\W\d_]", text_sample, re.UNICODE)
        tokens = re.findall(r"[a-zA-Z']+", text_sample.lower())
        latin_share = (sum(len(t) for t in tokens) / len(letters)) if letters else 1.0
        func_share = (sum(1 for t in tokens if t in tg.ENGLISH_WORDS) / len(tokens)) if tokens else 0.0
        span = (cues[-1]["e"] - cues[0]["s"]) if cues else 0.0
        words = sum(len(c["en"].split()) for c in cues)
        gemini_info = {
            "file": gem_path.name,
            "segments": len(segs),
            "cues": len(cues),
            "span": round(span, 2),
            "end": round(cues[-1]["e"], 2) if cues else 0.0,
            "words_per_sec": round(words / span, 2) if span > 0 else 0.0,
            "latin_share": round(latin_share, 4),
            "english_func_share": round(func_share, 4),
            "sample": segs[:8] if isinstance(segs, list) else [],
        }

    # 3. Recognition stage (hybrid cache when present, else legacy runner)
    hybrid_event = hybrid_video_events().get(vid)
    whisper_stage = (inspect_hybrid_stage(vid, hybrid_event) if hybrid_event is not None
                     else inspect_whisper_stage(vid))
    audio_info_summary = None
    info_path = WHISPER_BATCH_DIR / vid / "english_audio" / "audio.info.json"
    if info_path.exists():
        info_raw = read_json_safe(info_path, default={})
        if isinstance(info_raw, dict):
            fmts = [
                {
                    "format_id": f.get("format_id"),
                    "ext": f.get("ext"),
                    "language": f.get("language"),
                    "abr": f.get("abr"),
                    "acodec": f.get("acodec"),
                }
                for f in (info_raw.get("formats") or [])
                if f.get("acodec") not in (None, "none")
            ]
            audio_info_summary = {
                "duration": info_raw.get("duration"),
                "english_audio_ok": tg.english_audio_ok(info_raw),
                "audio_formats": fmts[:12],
            }

    # 4. Published subtitle file + live check_subs.inspect() & translation_issue()
    sub_path = SUBS_OUT_DIR / f"{vid}.json"
    published_sub = None
    if sub_path.exists():
        sub_data = read_json_safe(sub_path, default={})
        cues = sub_data.get("cues") or []
        issues = cs.inspect(cues)
        cue_issues = []
        for idx, c in enumerate(cues):
            iss = sr.translation_issue(c.get("zh"), c.get("en"))
            if iss:
                cue_issues.append({"index": idx + 1, "issue": iss})
        span = (cues[-1]["e"] - cues[0]["s"]) if cues else 0.0
        zh_chars = sum(len(str(c.get("zh") or "")) for c in cues)
        en_words = sum(len(str(c.get("en") or "").split()) for c in cues)
        published_sub = {
            "vid": sub_data.get("vid"),
            "source": sub_data.get("source"),
            "model": sub_data.get("model"),
            "translation_model": sub_data.get("translation_model"),
            "translation_models": sub_data.get("translation_models"),
            "translation_workers": sub_data.get("translation_workers"),
            "cue_count": len(cues),
            "span": round(span, 2),
            "chars_per_sec": round(zh_chars / span, 2) if span > 0 else 0.0,
            "words_per_sec": round(en_words / span, 2) if span > 0 else 0.0,
            "inspect_issues": issues,
            "translation_issues": cue_issues[:20],
            "cues": cues,
        }

    # 5. Comments
    com_path = COMMENTS_OUT_DIR / f"{vid}.json"
    comments_data = read_json_safe(com_path, default={}) if com_path.exists() else None

    status_map = read_json_safe(STATUS_PATH, default={})
    return {
        "vid": vid,
        "meta": meta,
        "batch_status": status_map.get(vid),
        "vtt_candidates": vtt_candidates,
        "vtt_groups": vtt_groups_summary,
        "gemini": gemini_info,
        "whisper_stage": whisper_stage,
        "audio_info": audio_info_summary,
        "published_sub": published_sub,
        "comments": (comments_data or {}).get("comments", []) if isinstance(comments_data, dict) else [],
    }


def search_videos(query: str, source_filter: str, limit: int = 80) -> list[dict[str, Any]]:
    catalog = get_video_catalog()
    subs_idx = get_subs_index()
    status_map = read_json_safe(STATUS_PATH, default={})
    q = query.strip().lower()

    results = []
    # Prioritize videos that have subs or are in whisper_batch
    candidate_vids = list(dict.fromkeys(
        list(reversed(list(status_map.keys()))) + list(subs_idx.keys()) + list(catalog.keys())
    ))
    for vid in candidate_vids:
        meta = catalog.get(vid, {"vid": vid, "title": vid, "score": 0})
        sub = subs_idx.get(vid)
        st = status_map.get(vid)
        sk = sub["source_kind"] if sub else (f"batch:{st.get('status')}" if st else "meta-only")
        if source_filter and source_filter != "all":
            if source_filter == "batch" and not st:
                continue
            elif source_filter != "batch" and sk != source_filter:
                continue
        if q:
            hay = f"{vid} {meta.get('title','')} {meta.get('title_zh','')} {meta.get('channel','')}".lower()
            if q not in hay:
                continue
        results.append({
            "vid": vid,
            "title": meta.get("title_zh") or meta.get("title") or vid,
            "title_en": meta.get("title") or vid,
            "channel": meta.get("channel", ""),
            "score": meta.get("score", 0),
            "source_kind": sk,
            "cue_count": sub["cue_count"] if sub else None,
            "model": (sub.get("translation_model") or sub.get("model")) if sub else None,
            "batch_status": st.get("status") if st else None,
            "has_comments": (COMMENTS_OUT_DIR / f"{vid}.json").exists(),
        })
        if len(results) >= limit:
            break
    return results


class PipelineHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/api/overview":
                self._send_json(build_overview_payload())
                return
            if path == "/api/live":
                vid = (qs.get("vid") or [None])[0]
                self._send_json(build_live_payload(vid))
                return
            if path.startswith("/api/video/"):
                vid = path.split("/api/video/", 1)[1].strip("/")
                self._send_json(build_video_trace(vid))
                return
            if path == "/api/videos":
                q = (qs.get("q") or [""])[0]
                src = (qs.get("source") or ["all"])[0]
                limit = min(300, max(1, int((qs.get("limit") or ["80"])[0])))
                self._send_json({"items": search_videos(q, src, limit)})
                return
            if path in ("/", "/index.html", "/reports/translation-pipeline.html"):
                body = HTML_PATH.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return

            # Also serve read-only static files under ROOT (site/, work/, data/, reports/)
            rel = path.lstrip("/")
            target = (ROOT / rel).resolve()
            if target.is_file() and target.is_relative_to(ROOT.resolve()) and not target.name.startswith("."):
                body = target.read_bytes()
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype == "application/json":
                    ctype += "; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return

            self._send_json({"error": f"not found: {path}"}, status=404)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/gateway-translate":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                sentences = [str(s).strip() for s in (body.get("sentences") or []) if str(s).strip()][:8]
                model = str(body.get("model") or ms.MODEL).strip()
                if not sentences:
                    self._send_json({"error": "sentences must be non-empty"}, status=400)
                    return
                t0 = time.perf_counter()
                parts = ms.call_gateway(sentences, timeout=60, attempts=1, model=model)
                elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
                checks = [
                    {"en": en, "zh": zh, "issue": sr.translation_issue(zh, en), "limit": sr.translation_limit(en)}
                    for en, zh in zip(sentences, parts)
                ]
                self._send_json({
                    "ok": True,
                    "model": model,
                    "gateway": ms.GATEWAY,
                    "elapsed_ms": elapsed_ms,
                    "input_count": len(sentences),
                    "output_count": len(parts),
                    "results": checks,
                })
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=200)
            return
        self._send_json({"error": "unsupported endpoint"}, status=404)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), PipelineHandler)
    print(f"Pipeline live server listening on http://{args.host}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
