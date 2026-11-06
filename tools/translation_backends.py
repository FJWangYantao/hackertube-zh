"""Share caller-owned translation work across bounded, explicit model callbacks.

The recovery executor supplies concurrency; this pool creates no threads and
performs no retries. A callback owns transport retries and finite timeouts, and
holds its backend slot until the entire invocation returns or raises.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from queue import Queue
from typing import Callable

ANTIGRAVITY_MODEL = "antigravity-tools/gemini-3.8-flash-low"
DEEPSEEK_CN_MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"
MAX_ANTIGRAVITY_WORKERS = 10
MAX_DEEPSEEK_WORKERS = 6
DEFAULT_ANTIGRAVITY_WORKERS = MAX_ANTIGRAVITY_WORKERS
DEFAULT_DEEPSEEK_WORKERS = MAX_DEEPSEEK_WORKERS


def validate_worker_counts(antigravity: int, deepseek: int) -> None:
    """Enforce the agreed per-upstream limits before any work starts."""
    for name, count, limit in (
        ("Antigravity", antigravity, MAX_ANTIGRAVITY_WORKERS),
        ("DeepSeek CN", deepseek, MAX_DEEPSEEK_WORKERS),
    ):
        if type(count) is not int or not 0 <= count <= limit:
            raise ValueError(f"{name} workers must be an integer between 0 and {limit}")
    if antigravity + deepseek == 0:
        raise ValueError("at least one translation backend must be enabled")


@dataclass(frozen=True)
class TranslationBackend:
    """One explicit model and the maximum simultaneous calls to its callback."""

    model: str
    workers: int
    translate: Callable[[list[str]], list[str]]

    def __post_init__(self) -> None:
        if not isinstance(self.model, str) or not self.model.strip():
            raise ValueError("model must be a nonblank string")
        if type(self.workers) is not int or self.workers < 1:
            raise ValueError("workers must be a positive integer")
        if not callable(self.translate):
            raise TypeError("translate must be callable")


class BackendPool:
    """Dispatch each call to the next free slot, without assigning fixed batches.

    Supply ``workers`` to the existing recovery executor and ``model_identity``
    to its checkpoint model argument. Capacity and backend order do not affect
    checkpoint identity. Returned metadata is a fresh JSON-serializable snapshot.
    Input lists are copied; callback outputs and exceptions pass through unchanged.
    """

    def __init__(self, backends: tuple[TranslationBackend, ...]) -> None:
        if not isinstance(backends, tuple) or not backends:
            raise ValueError("backends must be a nonempty tuple of TranslationBackend objects")
        if any(not isinstance(backend, TranslationBackend) for backend in backends):
            raise TypeError("each backend must be a TranslationBackend")
        models = tuple(backend.model for backend in backends)
        if len(set(models)) != len(models):
            raise ValueError("backend model IDs must be unique")
        self._backends = backends
        self._workers = sum(backend.workers for backend in backends)
        self._models = models
        self._model_identity = models[0] if len(models) == 1 else "pool:" + json.dumps(
            sorted(models), separators=(",", ":"),
        )
        self._slots: Queue[TranslationBackend] = Queue(maxsize=self._workers)
        for index in range(max(backend.workers for backend in backends)):
            for backend in backends:
                if index < backend.workers:
                    self._slots.put(backend)

    @property
    def workers(self) -> int:
        """Total concurrency to request from the caller's executor."""
        return self._workers

    @property
    def models(self) -> tuple[str, ...]:
        """Configured model IDs in configuration order."""
        return self._models

    @property
    def model_identity(self) -> str:
        """Stable model-set identity, retaining the legacy single-model value."""
        return self._model_identity

    @property
    def metadata(self) -> list[dict[str, str | int]]:
        """Configured capacities, excluded from the checkpoint identity."""
        return [{"model": backend.model, "workers": backend.workers}
                for backend in self._backends]

    def __call__(self, sentences: list[str]) -> list[str]:
        backend = self._slots.get()
        try:
            return backend.translate(list(sentences))
        finally:
            self._slots.put(backend)
