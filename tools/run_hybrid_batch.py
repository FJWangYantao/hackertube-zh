#!/usr/bin/env python3
"""Hybrid local/Deepgram ASR and globally bounded translation.

Default is a read-only plan. --run processes the selected videos; --publish
also creates site subtitles without overwriting existing files.
See docs/hybrid-pipeline.md. Do not run legacy batch/translation CLIs alongside.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import sys
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_subs
from deepgram_asr import DeepgramClient
from hybrid_pipeline import HybridJob, HybridPipeline, VIDEO_ID
from hybrid_runtime import GROUP_CHARS, HybridRuntime, batch_lock, group_recognition, legacy_modules
from subtitle_recovery import write_json_atomic
from translation_backends import (
    ANTIGRAVITY_MODEL, CLOUDC_MODEL, COMMANDCODE_MODEL, DEEPSEEK_CN_MODEL,
    GEMINI_LITE_MODEL, HUB_OAIFREE_MODEL, HUB_WANAI_MODEL, HIYO_MODEL,
    TRAE_MODEL, ZHACHA_MODEL,
    BackendPool, TranslationBackend, validate_pool_worker_counts,
)

ROOT = Path(__file__).resolve().parents[1]
MIN_FREE_BYTES = 3 * 1024**3
LOGGER = logging.getLogger(__name__)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ids-file", required=True, type=Path)
    parser.add_argument("--limit", type=int, help="Maximum selected videos, including in-flight jobs")
    parser.add_argument("--start-vid", help="Start from this pending video")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--local-workers", choices=(0, 1), type=int, default=1)
    parser.add_argument("--deepgram-workers", choices=range(0, 7), type=int, default=1,
                        metavar="{0..6}")
    parser.add_argument("--antigravity-workers", type=int, default=6)
    parser.add_argument("--trae-workers", type=int, default=5)
    parser.add_argument("--workbuddy-workers", type=int, default=5)
    parser.add_argument("--hiyo-workers", type=int, default=4)
    parser.add_argument("--cloudc-workers", type=int, default=4)
    parser.add_argument("--zhacha-workers", type=int, default=4)
    parser.add_argument("--hub-oaifree-workers", type=int, default=4)
    parser.add_argument("--hub-wanai-workers", type=int, default=4)
    parser.add_argument("--commandcode-workers", type=int, default=4)
    parser.add_argument("--gemini-lite-workers", type=int, default=6)
    parser.add_argument("--queue-low", type=int, default=8)
    parser.add_argument("--queue-high", type=int, default=32)
    parser.add_argument("--deepgram-timeout", type=float, default=180.0)
    parser.add_argument("--retry-uncertain", action="store_true",
                        help="Deliberately retry a possibly billed cloud request")
    parser.add_argument("--run", action="store_true", help="Execute; otherwise only print a plan")
    parser.add_argument("--publish", action="store_true", help="Allow creation of site subtitles")
    args = parser.parse_args(argv)
    try:
        validate_pool_worker_counts(worker_counts(args))
        if args.limit is not None and args.limit < 1:
            raise ValueError("--limit must be positive")
        if args.local_workers + args.deepgram_workers == 0:
            raise ValueError("enable at least one ASR worker")
        if not 0 <= args.queue_low < args.queue_high:
            raise ValueError("watermarks must satisfy 0 <= low < high")
        if not math.isfinite(args.deepgram_timeout) or args.deepgram_timeout <= 0:
            raise ValueError("Deepgram timeout must be positive and finite")
        if args.publish and not args.run:
            raise ValueError("--publish requires --run")
    except ValueError as exc:
        parser.error(str(exc))
    return args


def make_plan(args: argparse.Namespace, root: Path) -> list[HybridJob]:
    ids = list(dict.fromkeys(args.ids_file.read_text(encoding="utf-8-sig").split()))
    if any(not VIDEO_ID.fullmatch(vid) for vid in ids):
        raise ValueError("invalid video id in input file")
    legacy, _ = legacy_modules()
    skipped = legacy.SKIP_LOGIN | legacy.SKIP_SILENT
    pending = [vid for vid in ids if vid not in skipped
               and not (root / "site" / "data" / "subs" / f"{vid}.json").exists()]
    if args.start_vid:
        if args.start_vid not in pending:
            raise ValueError("--start-vid is not a pending video")
        pending = pending[pending.index(args.start_vid):]
    if args.limit is not None:
        pending = pending[:args.limit]
    # Existing durations provide useful admission reservations without downloads.
    status = root / "work" / "whisper_batch" / "status.json"
    history = json.loads(status.read_text(encoding="utf-8")) if status.exists() else {}
    if not isinstance(history, dict):
        raise ValueError("invalid existing batch status")
    jobs = []
    for vid in pending:
        duration = history.get(vid, {}).get("duration")
        estimate = max(1, math.ceil(duration * 16 / GROUP_CHARS)) if (
            type(duration) in (int, float) and math.isfinite(duration) and duration > 0) else 8
        jobs.append(HybridJob(vid, root / "work" / "hybrid_batch" / vid, estimate))
    return jobs


def worker_counts(args: argparse.Namespace) -> dict[str, int]:
    """Per-model concurrency for the three hybrid translation backends."""
    return {
        ANTIGRAVITY_MODEL: args.antigravity_workers,
        TRAE_MODEL: args.trae_workers,
        DEEPSEEK_CN_MODEL: args.workbuddy_workers,
        HIYO_MODEL: args.hiyo_workers,
        CLOUDC_MODEL: args.cloudc_workers,
        ZHACHA_MODEL: args.zhacha_workers,
        HUB_OAIFREE_MODEL: args.hub_oaifree_workers,
        HUB_WANAI_MODEL: args.hub_wanai_workers,
        COMMANDCODE_MODEL: args.commandcode_workers,
        GEMINI_LITE_MODEL: args.gemini_lite_workers,
    }


def translation_pool(args: argparse.Namespace) -> BackendPool:
    # DeepSeek-family backends honour the DeepSeek thinking switch; GLM/hiyo
    # lanes ignore or require it, so leave those requests untouched.
    thinking_off = frozenset({TRAE_MODEL, DEEPSEEK_CN_MODEL, COMMANDCODE_MODEL})

    def callback(model: str) -> partial:
        kwargs = {"thinking": {"type": "disabled"}} if model in thinking_off else {}
        return partial(make_subs.call_gateway, model=model, **kwargs)

    return BackendPool(tuple(TranslationBackend(model, count, callback(model))
        for model, count in worker_counts(args).items() if count))


class StatusWriter:
    """Only the coordinator calls this; no cross-thread whole-file updates."""

    def __init__(self, path: Path, configuration: dict) -> None:
        self.path = path
        self.payload = {"version": 1, "configuration": configuration, "videos": {}}

    def __call__(self, event: dict) -> None:
        videos = self.payload["videos"]
        if event["event"] == "video":
            videos = {**videos, event["vid"]: event}
            LOGGER.info("video=%s status=%s phase=%s", event["vid"], event["status"],
                        event.get("phase", event.get("provider", "")))
        self.payload = {**self.payload, "videos": videos, "latest": event,
                        "active_vids": [vid for vid, value in videos.items()
                                        if value["status"] in ("recognizing", "translating")]}
        write_json_atomic(self.path, self.payload)


def execute(args: argparse.Namespace, jobs: list[HybridJob], root: Path) -> int:
    # Check credentials/configuration before any stage file or download is created.
    client = None
    if args.deepgram_workers:
        key = os.environ.get("DEEPGRAM_API_KEY", "")
        if not key:
            raise ValueError("set DEEPGRAM_API_KEY in the process environment before --run")
        client = DeepgramClient(key, timeout=args.deepgram_timeout)
    if shutil.disk_usage(root).free < MIN_FREE_BYTES:
        raise ValueError("less than 3 GB free; no work started")
    pool = translation_pool(args)
    runtime = HybridRuntime(root, device=args.device, deepgram=client,
        publish=args.publish, retry_uncertain=args.retry_uncertain, translation_pool=pool)
    recognizers = {}
    if args.local_workers:
        recognizers["local"] = (1, runtime.recognize_local)
    if args.deepgram_workers:
        recognizers["deepgram"] = (args.deepgram_workers, runtime.recognize_deepgram)
    stage = root / "work" / "hybrid_batch"
    status = StatusWriter(stage / "status.json", {
        "local_workers": args.local_workers, "deepgram_workers": args.deepgram_workers,
        "translation_workers": pool.metadata, "queue_low": args.queue_low,
        "queue_high": args.queue_high, "publish": args.publish,
    })
    pipeline = HybridPipeline(recognizers=recognizers, translate=pool,
        group=group_recognition, finish=runtime.finish, queue_low=args.queue_low,
        queue_high=args.queue_high, on_event=status, on_interrupt=runtime.close_local)
    try:
        with batch_lock(stage / "batch.lock"):
            results = pipeline.run(jobs)
    finally:
        runtime.close_local()
    failed = sum(state["status"] == "failed" for state in results.values())
    print(json.dumps({"completed": len(results) - failed, "failed": failed,
                      "published_enabled": args.publish, "status_file": str(status.path)}))
    return int(bool(failed))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    jobs = make_plan(args, ROOT)
    plan = {"mode": "execute" if args.run else "plan-only", "videos": len(jobs),
            "local_workers": args.local_workers, "deepgram_workers": args.deepgram_workers,
            "translation_workers": sum(worker_counts(args).values()),
            "queue_low": args.queue_low, "queue_high": args.queue_high,
            "publish": args.publish, "video_ids": [job.vid for job in jobs]}
    print(json.dumps(plan, ensure_ascii=False))
    if not args.run or not jobs:
        return 0
    return execute(args, jobs, ROOT)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        LOGGER.warning("Interrupted; completed checkpoints and recognition caches retained")
        raise SystemExit(130)
    except (ValueError, OSError) as exc:
        LOGGER.error("%s: %s", type(exc).__name__, exc)
        raise SystemExit(1)
