"""Provider-aware staging, recovery and publication for the hybrid CLI.

Network/model work is lazy. Tests inject audio and ASR functions; importing this
module does not initialize Whisper, read credentials or submit requests.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

import check_subs
import make_subs
import transcribe_gemini
from hybrid_pipeline import HybridJob, Recognition
from local_asr_worker import LocalWhisperProcess
from subtitle_recovery import translation_issue, write_json_atomic
from translation_backends import BackendPool

CACHE_VERSION = 1
SOURCE_MODELS = {"whisper-local": "faster-whisper-small.en", "deepgram": "nova-3"}
GROUP_CHARS = 1300


def legacy_modules() -> tuple:
    """Use only parameterized helpers; never modify old runner path globals."""
    work = str(Path(__file__).resolve().parents[1] / "work")
    if work not in sys.path:
        sys.path.insert(0, work)
    import run_whisper_batch
    import whisper_wl_runner
    return run_whisper_batch, whisper_wl_runner


def load_audio(vid: str) -> tuple[Path, float]:
    return legacy_modules()[0].get_audio(vid)


def load_local(device: str) -> object:
    return LocalWhisperProcess(device)


def transcribe_local(pipeline: object, audio: Path) -> list[dict]:
    if isinstance(pipeline, LocalWhisperProcess):
        return pipeline.transcribe(audio)
    runner = legacy_modules()[1]
    rows, _ = runner.normalize_overlaps(runner.recognize_batched(pipeline, audio))
    # Trimming overlap can clamp a word wholly beyond the boundary to zero
    # length. Keep source text intact, omit only those unusable word timings.
    return [{**row, "words": [word for word in row.get("words", [])
                             if word["start"] < word["end"]]} for row in rows]


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def finite(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_recognition(result: Recognition) -> None:
    if SOURCE_MODELS.get(result.source) != result.model:
        raise ValueError("unknown recognition source/model provenance")
    if not finite(result.duration) or result.duration <= 0:
        raise ValueError("audio duration must be positive and finite")
    if not isinstance(result.rows, list) or not result.rows:
        raise ValueError("empty recognition")
    previous = 0.0
    for row in result.rows:
        if not isinstance(row, dict):
            raise ValueError("invalid recognition row")
        start, end = row.get("start"), row.get("end")
        if not finite(start) or not finite(end) or not previous <= start < end <= result.duration + 0.1:
            raise ValueError("invalid recognition timeline")
        if not isinstance(row.get("text"), str) or not row["text"].strip():
            raise ValueError("blank recognition source")
        words = row.get("words", [])
        if not isinstance(words, list):
            raise ValueError("invalid word list")
        prior_word = start
        for word in words:
            if not isinstance(word, dict):
                raise ValueError("invalid word")
            a, b = word.get("start"), word.get("end")
            if not finite(a) or not finite(b) or not prior_word <= a < b <= end + 0.1:
                raise ValueError("invalid word timeline")
            if not isinstance(word.get("word"), str) or not word["word"].strip():
                raise ValueError("blank word")
            prior_word = b
        previous = end
    transcribe_gemini.check_language([
        {"en": row["text"]} for row in result.rows])


def group_recognition(result: Recognition) -> list[list[dict]]:
    validate_recognition(result)
    return make_subs.group_cues([
        {"s": row["start"], "e": row["end"], "en": row["text"]}
        for row in result.rows], max_chars=GROUP_CHARS)


@contextmanager
def batch_lock(path: Path) -> Iterator[None]:
    """Never steal a lock, including after interruption; inspect it manually."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"pid": os.getpid()}, stream)
        yield
    finally:
        path.unlink(missing_ok=True)


def create_json_exclusive(path: Path, payload: dict) -> bool:
    """Publish a complete file atomically, without replacing any existing target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            return False
        except (PermissionError, OSError):
            # Fallback on Windows when os.link is disallowed or fails with WinError 5
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                return False
            with open(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, allow_nan=False)
            return True
        return True
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class HybridRuntime:
    def __init__(
        self, root: Path, *, device: str = "cuda", deepgram: object = None,
        publish: bool = False, retry_uncertain: bool = False,
        audio_loader: Callable | None = None, local_loader: Callable | None = None,
        local_transcribe: Callable | None = None, translation_pool: BackendPool | None = None,
    ) -> None:
        self.root = root.resolve()
        self.device, self.deepgram = device, deepgram
        self.publish, self.retry_uncertain = publish, retry_uncertain
        self.audio_loader = audio_loader or load_audio
        self.local_loader = local_loader or load_local
        self.local_transcribe = local_transcribe or transcribe_local
        self.translation_pool = translation_pool
        self._pipeline = None

    def _cached(self, job: HybridJob) -> Recognition | None:
        path = job.stage / "recognition.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != CACHE_VERSION or data.get("vid") != job.vid:
                raise ValueError("recognition cache provenance mismatch")
            result = Recognition(job.vid, data.get("source"), data.get("model"),
                                 data.get("duration"), data.get("rows"))
            validate_recognition(result)
            audio = (self.root / data["audio_path"]).resolve()
            if not audio.is_relative_to(self.root / "work"):
                raise ValueError("cached audio is outside work")
            if audio.exists() and fingerprint(audio) != data.get("audio_sha256"):
                raise ValueError("cached audio content changed")
            return result
        marker = job.stage / "cloud_request.json"
        if marker.exists():
            data = json.loads(marker.read_text(encoding="utf-8"))
            if data.get("status") in ("submitted", "uncertain") and not self.retry_uncertain:
                raise RuntimeError("cloud request outcome uncertain; use --retry-uncertain deliberately")
        return None

    def _audio(self, job: HybridJob) -> tuple[Path, float]:
        audio, duration = self.audio_loader(job.vid)
        audio = Path(audio).resolve()
        if not audio.is_file() or not audio.is_relative_to(self.root / "work"):
            raise ValueError("audio must be an existing file inside work")
        if not finite(duration) or duration <= 0:
            raise ValueError("audio duration must be positive and finite")
        return audio, float(duration)

    def _save(self, job: HybridJob, result: Recognition, audio: Path) -> Recognition:
        validate_recognition(result)
        payload = {"version": CACHE_VERSION, "vid": job.vid, "source": result.source,
                   "model": result.model, "duration": result.duration, "rows": result.rows,
                   "audio_path": str(audio.relative_to(self.root)), "audio_sha256": fingerprint(audio)}
        write_json_atomic(job.stage / "recognition.json", payload)
        return result

    def recognize_local(self, job: HybridJob) -> Recognition:
        cached = self._cached(job)
        if cached is not None:
            return cached
        audio, duration = self._audio(job)
        if self._pipeline is None:
            self._pipeline = self.local_loader(self.device)
        try:
            rows = self.local_transcribe(self._pipeline, audio)
        except Exception:
            self.close_local()
            raise
        return self._save(job, Recognition(job.vid, "whisper-local",
                          SOURCE_MODELS["whisper-local"], duration, rows), audio)

    def close_local(self) -> None:
        pipeline, self._pipeline = self._pipeline, None
        if isinstance(pipeline, LocalWhisperProcess):
            pipeline.close()

    def recognize_deepgram(self, job: HybridJob) -> Recognition:
        cached = self._cached(job)
        if cached is not None:
            return cached
        if self.deepgram is None:
            raise ValueError("Deepgram client is not configured")
        audio, duration = self._audio(job)
        marker = job.stage / "cloud_request.json"
        write_json_atomic(marker, {"status": "submitted", "vid": job.vid})
        try:
            rows = self.deepgram.transcribe(audio, duration)
            result = self._save(job, Recognition(job.vid, "deepgram", "nova-3", duration, rows), audio)
        except Exception as exc:
            # Invalid data after HTTP success may already be billed too. Only
            # explicit request rejections are safe to submit again normally.
            rejected = getattr(exc, "status", None) in (400, 401, 402, 403, 404, 405, 413, 415, 422, 429)
            uncertain = bool(getattr(exc, "uncertain", True)) or not rejected
            write_json_atomic(marker, {"status": "uncertain" if uncertain else "failed",
                                      "vid": job.vid, "error_type": type(exc).__name__})
            raise
        write_json_atomic(marker, {"status": "completed", "vid": job.vid})
        return result

    def _subtitle(self, result: Recognition, cues: list[dict]) -> dict:
        validate_recognition(result)
        if len(cues) != len(result.rows) or any(
            cue.get("en") != row["text"] or cue.get("s") != row["start"]
            or cue.get("e") != row["end"] for cue, row in zip(cues, result.rows)
        ):
            raise ValueError("translation changed source count, timing or order")
        rounded = [{"s": round(cue["s"], 2), "e": round(cue["e"], 2),
                    "en": cue["en"], "zh": cue.get("zh")} for cue in cues]
        issues = check_subs.inspect(rounded)
        issues += [issue for cue in rounded
                   if (issue := translation_issue(cue["zh"], cue["en"]))]
        for cue in rounded:
            if len(cue["en"].split()) > 25 and len(cue["en"].split()) / max(cue["e"] - cue["s"], 0.001) > 8:
                issues.append("collapsed source timeline")
        if issues:
            raise ValueError("subtitle validation failed: " + "; ".join(issues))
        pool = self.translation_pool
        return {"vid": result.vid, "source": result.source, "model": result.model,
                "translation_model": pool.model_identity if pool else "unspecified",
                "translation_models": list(pool.models) if pool else [],
                "translation_workers": {entry["model"]: entry["workers"] for entry in pool.metadata} if pool else {},
                "cues": rounded}

    def finish(self, job: HybridJob, result: Recognition, cues: list[dict]) -> None:
        if result.vid != job.vid:
            raise ValueError("subtitle video provenance mismatch")
        payload = self._subtitle(result, cues)
        write_json_atomic(job.stage / "subtitle.json", payload)
        if self.publish:
            create_json_exclusive(self.root / "site" / "data" / "subs" / f"{job.vid}.json", payload)
