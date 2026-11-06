"""Persistent Whisper subprocess with a deadline and bounded termination.

The parent exchanges one JSON line per audio file. No native model is imported
until this script is explicitly launched as the worker process.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import threading
from pathlib import Path
from queue import Empty, Full, Queue

# -I excludes the script directory; add only our fixed trusted application path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parents[1]
LOCAL_TIMEOUT = 600.0
STOP_GRACE = 2.0


class LocalWhisperProcess:
    def __init__(self, device: str, *, timeout: float = LOCAL_TIMEOUT) -> None:
        if device not in ("cpu", "cuda") or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("invalid local ASR device/deadline")
        self.timeout = timeout
        self.responses: Queue = Queue(maxsize=2)
        self.closed = threading.Event()
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-X", "utf8", str(Path(__file__).resolve()), "--device", device],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=ROOT,
        )
        self.reader = threading.Thread(target=self._read, name="local-asr-output", daemon=True)
        self.reader.start()

    def _read(self) -> None:
        try:
            for line in self.process.stdout:
                self.responses.put(line, timeout=1)
        except (OSError, ValueError, Full):
            # Receiver will observe EOF/deadline; no unbounded output buffering.
            pass
        finally:
            try:
                self.responses.put(None, timeout=1)
            except Full:
                pass

    def transcribe(self, audio: Path) -> list[dict]:
        if self.closed.is_set() or self.process.poll() is not None:
            raise RuntimeError("local ASR process is closed")
        try:
            self.process.stdin.write(json.dumps({"audio": str(audio)}) + "\n")
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise RuntimeError("local ASR input pipe closed") from None
        try:
            response = self.responses.get(timeout=self.timeout)
        except Empty:
            self.close()
            raise TimeoutError("local ASR exceeded its 600-second deadline") from None
        if response is None:
            raise RuntimeError("local ASR process ended before returning a result")
        try:
            payload = json.loads(response)
            if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
                raise ValueError
        except (ValueError, TypeError):
            self.close()
            raise RuntimeError("local ASR returned invalid data") from None
        return payload["rows"]

    def close(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        if self.process.poll() is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=STOP_GRACE)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=STOP_GRACE)
        self.reader.join(timeout=STOP_GRACE)
        self.process.stdin.close()
        self.process.stdout.close()


def serve(device: str) -> None:
    from hybrid_runtime import legacy_modules, transcribe_local
    _, runner = legacy_modules()
    pipeline = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("audio"), str):
                raise ValueError("invalid request")
            audio = Path(request["audio"]).resolve()
            if not audio.is_file() or not audio.is_relative_to(ROOT / "work"):
                raise ValueError("audio must be inside work")
            if pipeline is None:
                pipeline = runner.load_pipeline(device)
            rows = transcribe_local(pipeline, audio)
            response = {"rows": rows}
        except Exception as exc:
            response = {"error_type": type(exc).__name__}
        print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    serve(parser.parse_args().device)
