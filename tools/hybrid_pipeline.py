"""Coordinate bounded ASR producers and ONE translation executor across videos.

See docs/hybrid-pipeline.md. This module does not download, publish, load models,
or own credentials. Callbacks implement those boundaries and finite timeouts.
"""
from __future__ import annotations

import hashlib
import re
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from subtitle_recovery import RecoverySession, TranslationWork
from translation_backends import BackendPool

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
REASON_LIMIT = 200


def failure_reason(exc: BaseException) -> str:
    """Short operator-facing reason; adapters already sanitize their messages."""
    message = " ".join(str(exc).split())
    return (f"{type(exc).__name__}: {message}" if message else type(exc).__name__)[:REASON_LIMIT]


@dataclass(frozen=True)
class HybridJob:
    vid: str
    stage: Path
    estimated_groups: int = 1

    def __post_init__(self) -> None:
        if not VIDEO_ID.fullmatch(self.vid):
            raise ValueError("invalid video id")
        if type(self.estimated_groups) is not int or self.estimated_groups < 1:
            raise ValueError("estimated_groups must be a positive integer")


@dataclass(frozen=True)
class Recognition:
    vid: str
    source: str
    model: str
    duration: float
    rows: list[dict]


@dataclass(frozen=True)
class VideoSession:
    job: HybridJob
    recognition: Recognition
    translation: RecoverySession


class HybridPipeline:
    """Single coordinator owns all sessions, checkpoint writes and future maps.

    queue_high is an ASR admission watermark, not a maximum transcript size.
    Existing ASR work may complete above it; translation submission remains hard
    bounded by translate.workers. No work is submitted inside worker callbacks.
    """

    def __init__(
        self, *, recognizers: dict[str, tuple[int, Callable]], translate: BackendPool,
        group: Callable[[Recognition], list[list[dict]]], finish: Callable,
        queue_low: int = 8, queue_high: int = 32, on_event: Callable | None = None,
        on_interrupt: Callable | None = None,
    ) -> None:
        if type(queue_low) is not int or type(queue_high) is not int or not 0 <= queue_low < queue_high:
            raise ValueError("queue watermarks must satisfy 0 <= low < high")
        if not recognizers or any(
            name not in ("local", "deepgram") or type(capacity) is not int
            or not 1 <= capacity <= (1 if name == "local" else 2) or not callable(callback)
            for name, (capacity, callback) in recognizers.items()
        ):
            raise ValueError("enable local capacity 1 and/or Deepgram capacity 1..2")
        self.recognizers = dict(recognizers)
        self.translate = translate
        self.group = group
        self.finish = finish
        self.low, self.high = queue_low, queue_high
        self.on_event = on_event or (lambda event: None)
        self.on_interrupt = on_interrupt or (lambda: None)
        self.sessions: dict[str, VideoSession] = {}
        self.order: deque[str] = deque()
        self.asr: dict[Future, tuple[str, HybridJob]] = {}
        self.translation: dict[Future, tuple[str, TranslationWork]] = {}
        self.states: dict[str, dict] = {}
        self.collection_failures: dict[str, str] = {}
        self.paused = False

    def emit(self, event: str, **details: object) -> None:
        self.on_event({"event": event, "translation_active": len(self.translation),
                       "backlog_groups": self.backlog, "asr_active": len(self.asr),
                       **details})

    @property
    def backlog(self) -> int:
        return sum(session.translation.pending_count for vid, session in self.sessions.items()
                   if vid not in self.collection_failures)

    def _set_state(self, vid: str, status: str, **details: object) -> None:
        self.states = {**self.states, vid: {"status": status, **details}}
        self.emit("video", vid=vid, **self.states[vid])

    def _admission(self, job: HybridJob) -> bool:
        reserved = sum(item.estimated_groups for _, item in self.asr.values())
        load = self.backlog + reserved
        if self.paused and load <= self.low:
            self.paused = False
            self.emit("admission", paused=False)
        elif not self.paused and load >= self.high:
            self.paused = True
            self.emit("admission", paused=True)
        if self.paused:
            return False
        # A single large video must be able to start on an empty pipeline.
        if load and load + job.estimated_groups > self.high:
            return False
        return True

    def _admit(self, pending: deque[HybridJob], executors: dict) -> None:
        for name, (capacity, callback) in self.recognizers.items():
            count = sum(provider == name for provider, _ in self.asr.values())
            while pending and count < capacity and self._admission(pending[0]):
                job = pending.popleft()
                future = executors[name].submit(callback, job)
                self.asr[future] = (name, job)
                count += 1
                self._set_state(job.vid, "recognizing", provider=name)

    def _recognition_done(self, future: Future) -> None:
        provider, job = self.asr.pop(future)
        try:
            result = future.result()
            if not isinstance(result, Recognition) or result.vid != job.vid:
                raise ValueError("recognizer returned a different video")
            groups = self.group(result)
            identity = hashlib.sha256(self.translate.model_identity.encode()).hexdigest()[:16]
            session = RecoverySession(groups, job.stage / f"translation.{identity}.json",
                                      model=self.translate.model_identity)
            self.sessions = {**self.sessions, job.vid: VideoSession(job, result, session)}
            self.order.append(job.vid)
            self._set_state(job.vid, "translating", provider=provider,
                            source=result.source, model=result.model,
                            duration=result.duration, checkpoint=str(session.path))
        except Exception as exc:
            self._set_state(job.vid, "failed", phase="recognition",
                            error_type=type(exc).__name__, reason=failure_reason(exc))

    def _dispatch(self, executor: ThreadPoolExecutor) -> None:
        while len(self.translation) < self.translate.workers:
            candidate = None
            for _ in range(len(self.order)):
                vid = self.order.popleft()
                self.order.append(vid)
                if vid in self.collection_failures:
                    continue
                session = self.sessions[vid].translation
                work = session.take()
                if work is not None:
                    candidate = (vid, session, work)
                    break
            if candidate is None:
                break
            vid, session, work = candidate
            future = executor.submit(self.translate, session.texts(work))
            self.translation[future] = (vid, work)
        self.emit("dispatch")

    def _translation_done(self, future: Future) -> None:
        vid, work = self.translation.pop(future)
        session = self.sessions[vid].translation
        try:
            try:
                output = future.result()
            except Exception as exc:
                session.accept(work, error=exc)
            else:
                session.accept(work, output)
        except Exception as exc:
            # A video-specific checkpoint failure must not discard another
            # video's in-flight results. Drain this video, stop its new work.
            self.collection_failures = {**self.collection_failures, vid: type(exc).__name__}
            self.emit("checkpoint_error", vid=vid, error_type=type(exc).__name__)

    def _finalize(self) -> None:
        for vid, session in tuple(self.sessions.items()):
            if vid in self.collection_failures:
                if any(item_vid == vid for item_vid, _ in self.translation.values()):
                    continue
                self._set_state(vid, "failed", phase="checkpoint",
                                error_type=self.collection_failures[vid])
            elif session.translation.done:
                try:
                    cues = session.translation.result()
                    self.finish(session.job, session.recognition, cues)
                    self._set_state(vid, "completed", source=session.recognition.source)
                except Exception as exc:
                    self._set_state(vid, "failed", phase="translation_or_validation",
                                    error_type=type(exc).__name__, reason=failure_reason(exc))
            else:
                continue
            self.sessions = {key: value for key, value in self.sessions.items() if key != vid}
            self.order = deque(key for key in self.order if key != vid)

    def _drive(self, pending: deque[HybridJob], executors: dict, executor: ThreadPoolExecutor) -> None:
        while pending or self.asr or self.sessions:
            self._finalize()
            self._admit(pending, executors)
            self._dispatch(executor)
            active = tuple(self.asr) + tuple(self.translation)
            if not active:
                continue
            finished, _ = wait(active, return_when=FIRST_COMPLETED)
            for future in finished:
                if future in self.asr:
                    self._recognition_done(future)
                else:
                    self._translation_done(future)

    def run(self, jobs: list[HybridJob]) -> dict[str, dict]:
        if len({job.vid for job in jobs}) != len(jobs):
            raise ValueError("duplicate video jobs are not allowed")
        if self.states or self.asr or self.sessions:
            raise ValueError("create a fresh HybridPipeline for each run")
        pending = deque(jobs)
        with ExitStack() as stack:
            executors = {name: stack.enter_context(ThreadPoolExecutor(
                max_workers=count, thread_name_prefix=f"asr-{name}"))
                for name, (count, _) in self.recognizers.items()}
            executor = stack.enter_context(ThreadPoolExecutor(
                max_workers=self.translate.workers, thread_name_prefix="translation"))
            try:
                self._drive(pending, executors, executor)
            except KeyboardInterrupt:
                self.on_interrupt()
                # Already-started paid/gateway calls finish within their callback
                # timeouts. Preserve those successes, but submit no repairs/jobs.
                for future in tuple(self.translation):
                    self._translation_done(future)
                self.emit("interrupted")
                raise
            self.emit("finished")
        return dict(self.states)
