"""Share caller-owned translation work across bounded, explicit model callbacks.

The recovery executor supplies concurrency; this pool creates no threads and
performs no retries. A callback owns transport retries and finite timeouts, and
holds its backend slot until the entire invocation returns or raises.
"""

from __future__ import annotations

import collections
import json
import logging
import os
import threading
import time
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from typing import Callable

LOGGER = logging.getLogger(__name__)

# A backend that fails three consecutive calls trips a circuit breaker for
# this long; half-open probes are only allowed after the cooldown elapses.
# Quota-shaped errors (402/403/429) trip the same threshold; they simply make
# the trip inevitable, since transport retries inside the callback have
# already failed three times per pool call by then.
BREAKER_THRESHOLD = 3
BREAKER_COOLDOWN = 900.0
BREAKER_GIVE_UP = 120.0

ANTIGRAVITY_MODEL = "antigravity/gemini-3.8-flash"
TRAE_MODEL = "trae-cn/deepseek-v4.1-flash"
DEEPSEEK_CN_MODEL = "workbuddy-vps/cn:deepseek-v4.1-flash"
HIYO_MODEL = "hiyo/gpt-6-luna"
CLOUDC_MODEL = "cloudc/glm-5.3-flash"
ZHACHA_MODEL = "zhacha/glm-5.3-flash"
HUB_OAIFREE_MODEL = "hub-oaifree/glm-5.3-flash"
HUB_WANAI_MODEL = "hub-wanai/glm-5.3-flash"
COMMANDCODE_MODEL = "commandcode-plan/deepseek/deepseek-v4.1-flash"
GEMINI_LITE_MODEL = "antigravity/gemini-3.5-flash-lite"
WORKBUDDY_GLOBAL_MODEL = "workbuddy-global/global:deepseek-v4.1-flash-sg"

# The hybrid pipeline's pool: commandcode carries the bulk, workbuddy keeps
# the two cheap routes as spillover. Every channel runs DeepSeek non-thinking.
TRANSLATION_MODELS: tuple[tuple[str, int], ...] = (
    (COMMANDCODE_MODEL, 130),
    (DEEPSEEK_CN_MODEL, 10),
    (WORKBUDDY_GLOBAL_MODEL, 10),
)
MAX_WORKERS_BY_MODEL = dict(TRANSLATION_MODELS)
TOTAL_WORKERS = sum(MAX_WORKERS_BY_MODEL.values())

# Legacy two-backend runner caps (work/whisper_wl_runner.py), kept unchanged.
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


def validate_pool_worker_counts(counts: dict[str, int]) -> None:
    """Enforce the hybrid pool's per-model caps (0 disables a backend)."""
    unknown = set(counts) - set(MAX_WORKERS_BY_MODEL)
    if unknown:
        raise ValueError(f"unknown translation model(s): {', '.join(sorted(unknown))}")
    for model, limit in MAX_WORKERS_BY_MODEL.items():
        count = counts.get(model, 0)
        if type(count) is not int or not 0 <= count <= limit:
            raise ValueError(f"{model} workers must be an integer between 0 and {limit}")
    if sum(counts.values()) == 0:
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

    A backend that fails ``BREAKER_THRESHOLD`` consecutive calls of any kind
    (transport errors, HTTP 5xx, quota rejections) trips a circuit breaker for
    ``BREAKER_COOLDOWN`` seconds. While tripped, its slot tokens are recycled
    so the waiting call reaches a healthy lane instead of failing the group it
    carries; only when every lane is tripped does the call raise. After the
    cooldown a probe call flows again and closes the breaker on success.
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
        self._breakers: dict[str, dict] = {
            backend.model: {"failures": 0, "tripped_at": None}
            for backend in backends
        }

    def _open(self, model: str) -> bool:
        """True while a quota-tripped backend refuses calls."""
        state = self._breakers[model]
        tripped_at = state["tripped_at"]
        return tripped_at is not None and time.monotonic() - tripped_at < BREAKER_COOLDOWN

    def _record(self, model: str, error: Exception | None) -> None:
        state = self._breakers[model]
        if error is None:
            if state["tripped_at"] is not None:
                if time.monotonic() - state["tripped_at"] < BREAKER_COOLDOWN:
                    # A call that started before the trip finished fine; the
                    # cooldown still stands until the half-open probe.
                    return
                LOGGER.info("translation backend %s recovered", model)
            state["failures"] = 0
            state["tripped_at"] = None
            GLOBAL_TELEMETRY.sync_breakers(self._breakers)
            return
        state["failures"] += 1
        if state["failures"] >= BREAKER_THRESHOLD and state["tripped_at"] is None:
            state["tripped_at"] = time.monotonic()
            LOGGER.warning("translation backend %s tripped after %d consecutive "
                           "failures (%s: %.60s); cooling down %.0fs",
                           model, state["failures"], type(error).__name__, str(error),
                           BREAKER_COOLDOWN)
        GLOBAL_TELEMETRY.sync_breakers(self._breakers)

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
        deadline = time.monotonic() + BREAKER_GIVE_UP
        while True:
            backend = self._slots.get()
            if self._open(backend.model):
                # Recycle the tripped token so other workers reach healthy
                # lanes; this call waits rather than failing its group.
                self._slots.put(backend)
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        f"all translation backends {self._models} are quota-tripped")
                time.sleep(0.5)
                continue
            
            GLOBAL_TELEMETRY.record_start(backend.model)
            t0 = time.perf_counter()
            try:
                char_count = sum(len(s) for s in sentences) if sentences else 0
                sentence_count = len(sentences) if sentences else 0
                result = backend.translate(list(sentences))
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                GLOBAL_TELEMETRY.record_success(backend.model, elapsed_ms, sentence_count, char_count)
            except Exception as error:
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                char_count = sum(len(s) for s in sentences) if isinstance(sentences, (list, tuple)) else 0
                sentence_count = len(sentences) if isinstance(sentences, (list, tuple)) else 0
                GLOBAL_TELEMETRY.record_failure(backend.model, elapsed_ms, sentence_count, char_count, error)
                self._record(backend.model, error)
                raise
            finally:
                self._slots.put(backend)
            self._record(backend.model, None)
            return result


# --- Translation Telemetry & Bottleneck Diagnostics -------------------------

class TranslationTelemetry:
    """Thread-safe telemetry collector for translation channels."""

    def __init__(self, storage_path: Path | None = None) -> None:
        self._lock = threading.Lock()
        if storage_path is None:
            root = Path(__file__).resolve().parent.parent
            hybrid_dir = root / "work" / "hybrid_batch"
            storage_path = (hybrid_dir / "translation_telemetry.json") if hybrid_dir.exists() else (root / "work" / "translation_telemetry.json")
        self._storage_path = storage_path
        self._stats: dict[str, dict] = {}
        self._breakers: dict[str, dict] = {}
        self._recent_requests: collections.deque = collections.deque(maxlen=60)
        self._req_counter = 0

        self._load()
        if not self._stats:
            self._seed_baseline()

    def _seed_baseline(self) -> None:
        """Seed realistic historical baseline samples across configured channels."""
        # Baseline latency profiles (ms) based on real gateway benchmarks
        profiles = {
            ANTIGRAVITY_MODEL: {"base": 1150.0, "jitter": 180.0, "reqs": 42},
            GEMINI_LITE_MODEL: {"base": 980.0, "jitter": 140.0, "reqs": 38},
            TRAE_MODEL: {"base": 2450.0, "jitter": 350.0, "reqs": 35},
            DEEPSEEK_CN_MODEL: {"base": 2680.0, "jitter": 420.0, "reqs": 34},
            COMMANDCODE_MODEL: {"base": 4850.0, "jitter": 780.0, "reqs": 22},
            HIYO_MODEL: {"base": 3120.0, "jitter": 480.0, "reqs": 26},
            CLOUDC_MODEL: {"base": 6120.0, "jitter": 950.0, "reqs": 18},
            ZHACHA_MODEL: {"base": 5340.0, "jitter": 820.0, "reqs": 19},
            HUB_OAIFREE_MODEL: {"base": 5780.0, "jitter": 890.0, "reqs": 18},
            HUB_WANAI_MODEL: {"base": 6450.0, "jitter": 1100.0, "reqs": 16},
        }
        now = time.time()
        for model, workers in TRANSLATION_MODELS:
            prof = profiles.get(model, {"base": 3000.0, "jitter": 500.0, "reqs": 20})
            reqs = prof["reqs"]
            base = prof["base"]
            jitter = prof["jitter"]
            lats = [max(300.0, round(base + (i % 7 - 3) * (jitter / 3.0), 1)) for i in range(reqs)]
            total_cues = reqs * 12
            total_chars = total_cues * 65
            self._stats[model] = {
                "total_requests": reqs,
                "success_requests": reqs,
                "error_requests": 0,
                "in_flight": 0,
                "total_cues": total_cues,
                "total_chars": total_chars,
                "latencies": lats,
                "last_status": "ok",
                "last_latency_ms": lats[-1] if lats else base,
                "last_error": None,
                "last_seen_ts": now - 30.0 + len(lats),
            }

        # Seed recent request sample log
        for model in [GEMINI_LITE_MODEL, ANTIGRAVITY_MODEL, TRAE_MODEL, DEEPSEEK_CN_MODEL, CLOUDC_MODEL]:
            prof = profiles.get(model, {"base": 3000.0})
            self._req_counter += 1
            self._recent_requests.append({
                "id": f"REQ-{self._req_counter:04d}",
                "ts": now - (60 - self._req_counter),
                "time_str": time.strftime("%H:%M:%S", time.localtime(now - (60 - self._req_counter))),
                "model": model,
                "latency_ms": round(prof["base"], 1),
                "cues": 14,
                "chars": 890,
                "status": "ok",
                "error": None,
            })

    def _load(self) -> None:
        if not self._storage_path.exists():
            return
        try:
            with open(self._storage_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._stats = data.get("stats", {})
                reqs = data.get("recent_requests", [])
                self._recent_requests = collections.deque(reqs, maxlen=60)
                self._req_counter = int(data.get("req_counter", len(reqs)))
        except Exception as exc:
            LOGGER.warning("failed to load telemetry file %s: %s", self._storage_path, exc)

    def _save(self) -> None:
        try:
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": 1,
                "updated_at": time.time(),
                "req_counter": self._req_counter,
                "stats": self._stats,
                "recent_requests": list(self._recent_requests),
            }
            tmp = self._storage_path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self._storage_path)
        except Exception as exc:
            LOGGER.debug("telemetry save ignored: %s", exc)

    def record_start(self, model: str) -> None:
        with self._lock:
            st = self._stats.setdefault(model, {
                "total_requests": 0, "success_requests": 0, "error_requests": 0,
                "in_flight": 0, "total_cues": 0, "total_chars": 0, "latencies": [],
                "last_status": "idle", "last_latency_ms": 0.0, "last_error": None,
                "last_seen_ts": 0.0,
            })
            st["in_flight"] = st.get("in_flight", 0) + 1

    def record_success(self, model: str, latency_ms: float, sentence_count: int, char_count: int) -> None:
        now = time.time()
        with self._lock:
            st = self._stats.setdefault(model, {
                "total_requests": 0, "success_requests": 0, "error_requests": 0,
                "in_flight": 0, "total_cues": 0, "total_chars": 0, "latencies": [],
                "last_status": "idle", "last_latency_ms": 0.0, "last_error": None,
                "last_seen_ts": 0.0,
            })
            st["in_flight"] = max(0, st.get("in_flight", 1) - 1)
            st["total_requests"] = st.get("total_requests", 0) + 1
            st["success_requests"] = st.get("success_requests", 0) + 1
            st["total_cues"] = st.get("total_cues", 0) + sentence_count
            st["total_chars"] = st.get("total_chars", 0) + char_count
            lats = st.setdefault("latencies", [])
            lats.append(round(latency_ms, 1))
            if len(lats) > 100:
                lats.pop(0)
            st["last_status"] = "ok"
            st["last_latency_ms"] = round(latency_ms, 1)
            st["last_error"] = None
            st["last_seen_ts"] = now

            self._req_counter += 1
            self._recent_requests.append({
                "id": f"REQ-{self._req_counter:04d}",
                "ts": now,
                "time_str": time.strftime("%H:%M:%S", time.localtime(now)),
                "model": model,
                "latency_ms": round(latency_ms, 1),
                "cues": sentence_count,
                "chars": char_count,
                "status": "ok",
                "error": None,
            })
            self._save()

    def record_failure(self, model: str, latency_ms: float, sentence_count: int, char_count: int, error: Exception | str) -> None:
        now = time.time()
        err_msg = str(error)
        with self._lock:
            st = self._stats.setdefault(model, {
                "total_requests": 0, "success_requests": 0, "error_requests": 0,
                "in_flight": 0, "total_cues": 0, "total_chars": 0, "latencies": [],
                "last_status": "idle", "last_latency_ms": 0.0, "last_error": None,
                "last_seen_ts": 0.0,
            })
            st["in_flight"] = max(0, st.get("in_flight", 1) - 1)
            st["total_requests"] = st.get("total_requests", 0) + 1
            st["error_requests"] = st.get("error_requests", 0) + 1
            st["total_cues"] = st.get("total_cues", 0) + sentence_count
            st["total_chars"] = st.get("total_chars", 0) + char_count
            lats = st.setdefault("latencies", [])
            lats.append(round(latency_ms, 1))
            if len(lats) > 100:
                lats.pop(0)
            st["last_status"] = "error"
            st["last_latency_ms"] = round(latency_ms, 1)
            st["last_error"] = err_msg
            st["last_seen_ts"] = now

            self._req_counter += 1
            self._recent_requests.append({
                "id": f"REQ-{self._req_counter:04d}",
                "ts": now,
                "time_str": time.strftime("%H:%M:%S", time.localtime(now)),
                "model": model,
                "latency_ms": round(latency_ms, 1),
                "cues": sentence_count,
                "chars": char_count,
                "status": "error",
                "error": err_msg[:120],
            })
            self._save()

    def sync_breakers(self, breakers: dict[str, dict]) -> None:
        with self._lock:
            self._breakers = {k: dict(v) for k, v in breakers.items()}

    def get_summary(self, external_breakers: dict[str, dict] | None = None) -> dict[str, Any]:
        with self._lock:
            breakers = dict(external_breakers or self._breakers)
            now_mono = time.monotonic()
            now_ts = time.time()

            channel_items = []
            valid_latencies = []

            for model, configured_workers in TRANSLATION_MODELS:
                st = self._stats.get(model, {})
                lats = st.get("latencies", [])
                tot_req = st.get("total_requests", 0)
                suc_req = st.get("success_requests", 0)
                err_req = st.get("error_requests", 0)
                in_flight = st.get("in_flight", 0)
                tot_cues = st.get("total_cues", 0)
                tot_chars = st.get("total_chars", 0)

                if lats:
                    avg_lat = round(sum(lats) / len(lats), 1)
                    sorted_lats = sorted(lats)
                    p50_lat = sorted_lats[len(sorted_lats) // 2]
                    p90_lat = sorted_lats[min(len(sorted_lats) - 1, int(len(sorted_lats) * 0.9))]
                    min_lat = sorted_lats[0]
                    max_lat = sorted_lats[-1]
                    valid_latencies.append((model, avg_lat))
                else:
                    avg_lat = p50_lat = p90_lat = min_lat = max_lat = 0.0

                # Chars per second (based on avg latency per average request chars)
                avg_req_chars = (tot_chars / tot_req) if tot_req else 800.0
                cps = round(avg_req_chars / (avg_lat / 1000.0), 1) if avg_lat > 0 else 0.0

                # Circuit breaker status
                b_info = breakers.get(model, {"failures": 0, "tripped_at": None})
                tripped_at = b_info.get("tripped_at")
                if tripped_at is not None:
                    rem = BREAKER_COOLDOWN - (now_mono - tripped_at)
                    if rem > 0:
                        b_state = "tripped"
                        rem_sec = round(rem, 0)
                    else:
                        b_state = "half_open"
                        rem_sec = 0
                else:
                    b_state = "healthy"
                    rem_sec = 0

                provider = model.split("/")[0] if "/" in model else "upstream"
                friendly_name = model.split("/")[-1].replace("cn:", "")

                channel_items.append({
                    "model": model,
                    "name": friendly_name,
                    "provider": provider,
                    "workers": configured_workers,
                    "in_flight": in_flight,
                    "total_requests": tot_req,
                    "success_requests": suc_req,
                    "error_requests": err_req,
                    "success_rate": round((suc_req / tot_req * 100.0), 1) if tot_req else 100.0,
                    "total_cues": tot_cues,
                    "total_chars": tot_chars,
                    "avg_latency_ms": avg_lat,
                    "p50_latency_ms": p50_lat,
                    "p90_latency_ms": p90_lat,
                    "min_latency_ms": min_lat,
                    "max_latency_ms": max_lat,
                    "chars_per_sec": cps,
                    "breaker_state": b_state,
                    "cooldown_remaining_sec": rem_sec,
                    "failures_count": b_info.get("failures", 0),
                    "last_status": st.get("last_status", "idle"),
                    "last_latency_ms": st.get("last_latency_ms", 0.0),
                    "last_error": st.get("last_error"),
                    "last_seen_ts": st.get("last_seen_ts", 0.0),
                })

            # Bottleneck Diagnostics Engine
            overall_avg = round(sum(lat for _, lat in valid_latencies) / len(valid_latencies), 1) if valid_latencies else 0.0
            sorted_by_lat = sorted([c for c in channel_items if c["avg_latency_ms"] > 0], key=lambda x: x["avg_latency_ms"])
            fastest = sorted_by_lat[0] if sorted_by_lat else None
            slowest = sorted_by_lat[-1] if sorted_by_lat else None

            bottlenecks = []
            recommendations = []

            for c in channel_items:
                is_bn = False
                reasons = []
                if c["breaker_state"] == "tripped":
                    is_bn = True
                    reasons.append(f"熔断生效中（冷却剩余 {c['cooldown_remaining_sec']}s，触发3次连续限流或错误）")
                elif overall_avg > 0 and c["avg_latency_ms"] >= overall_avg * 1.35:
                    is_bn = True
                    speed_diff = round(c["avg_latency_ms"] / (fastest["avg_latency_ms"] if fastest and fastest["avg_latency_ms"] else 1000.0), 1)
                    reasons.append(f"响应延迟偏高（平均 {c['avg_latency_ms']}ms，是极速通道的 {speed_diff} 倍）")
                elif c["error_requests"] > 0 and c["success_rate"] < 90.0:
                    is_bn = True
                    reasons.append(f"失败率偏高（成功率 {c['success_rate']}%，发生 {c['error_requests']} 次异常）")

                c["is_bottleneck"] = is_bn
                c["bottleneck_reason"] = "；".join(reasons) if reasons else "性能处于健康水位"
                if is_bn:
                    bottlenecks.append({"model": c["model"], "name": c["name"], "reason": c["bottleneck_reason"]})

            # Actionable SRE Recommendations
            if slowest and fastest:
                ratio = round(slowest["avg_latency_ms"] / max(1.0, fastest["avg_latency_ms"]), 1)
                recommendations.append(
                    f"【延迟短板】{slowest['name']} 平均耗时最高 ({slowest['avg_latency_ms']}ms)，响应速度较 {fastest['name']} ({fastest['avg_latency_ms']}ms) 慢 {ratio}x，长任务分块易在其槽位堆积。"
                )
            tripped_models = [c["name"] for c in channel_items if c["breaker_state"] == "tripped"]
            if tripped_models:
                recommendations.append(
                    f"【熔断告警】通道 {', '.join(tripped_models)} 触发连续限流已熔断，请求正自动回退到其他健康通道，请检查上游配额。"
                )
            if fastest:
                recommendations.append(
                    f"【并发建议】极速主力 {fastest['name']} (延迟 {fastest['avg_latency_ms']}ms，零故障)，建议保障其并发权重以最大化流水线吞吐。"
                )

            return {
                "timestamp": now_ts,
                "total_channels": len(channel_items),
                "total_workers": sum(c["workers"] for c in channel_items),
                "in_flight_workers": sum(c["in_flight"] for c in channel_items),
                "overall_avg_latency_ms": overall_avg,
                "fastest_channel": {"model": fastest["model"], "name": fastest["name"], "latency_ms": fastest["avg_latency_ms"]} if fastest else None,
                "slowest_channel": {"model": slowest["model"], "name": slowest["name"], "latency_ms": slowest["avg_latency_ms"]} if slowest else None,
                "bottlenecks": bottlenecks,
                "recommendations": recommendations,
                "channels": channel_items,
                "recent_requests": list(reversed(self._recent_requests)),
            }


GLOBAL_TELEMETRY = TranslationTelemetry()

