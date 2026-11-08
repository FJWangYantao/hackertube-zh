"""Watch the pipeline's local helper services and restart them when they die.

Tonight both Magpie and bgutil died silently and stalled whole batches until a
human noticed. This loop probes each service every cycle and relaunches dead
ones detached. It never touches the batch process itself.

Run once with nohup; do not launch a second instance.
Log: work/watchdog.log
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_FILE = ROOT / "work" / "watchdog.log"
CYCLE_SECONDS = 120
DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

MAGPIE_DIR = Path.home() / "AppData" / "Local" / "Programs" / "magpie"
BGUTIL_DIR = Path.home() / "bgutil-pot-provider" / "server"

logging.basicConfig(
    filename=str(LOG_FILE), level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s", encoding="utf-8")
LOGGER = logging.getLogger("watchdog")


def alive(url: str) -> bool:
    """A service answers when it returns anything, even an HTTP error status."""
    try:
        urllib.request.urlopen(url, timeout=8)
        return True
    except urllib.error.HTTPError:
        return True  # the server responded, so it is up
    except Exception:
        return False


def spawn(cmd: list[str], cwd: str, log_path: Path) -> None:
    log = open(log_path, "ab")
    subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=log,
                     creationflags=DETACHED)


SERVICES = [
    {
        "name": "magpie",
        "check": "http://127.0.0.1:3425/v1/models",
        "cmd": [str(MAGPIE_DIR / "magpie.exe")],
        "cwd": str(MAGPIE_DIR),
        "log": MAGPIE_DIR / "magpie.log",
    },
    {
        "name": "bgutil-pot",
        "check": "http://127.0.0.1:4416/ping",
        "cmd": ["node", "build/main.js"],
        "cwd": str(BGUTIL_DIR),
        "log": BGUTIL_DIR / "server.log",
        "env": {"NODE_USE_ENV_PROXY": "1", "HTTP_PROXY": "http://127.0.0.1:7890",
                "HTTPS_PROXY": "http://127.0.0.1:7890"},
    },
    {
        "name": "pipeline-monitor",
        "check": "http://127.0.0.1:8767/reports/translation-pipeline.html",
        "cmd": [sys.executable, "-I", "tools/pipeline_server.py", "--port", "8767"],
        "cwd": str(ROOT),
        "log": ROOT / "work" / "pipeline_server.log",
    },
]


def check_cycle() -> None:
    for svc in SERVICES:
        if alive(svc["check"]):
            continue
        LOGGER.warning("service %s is down at %s; relaunching",
                       svc["name"], time.strftime("%H:%M:%S"))
        env = dict(os.environ)
        env.update(svc.get("env", {}))
        try:
            spawn(svc["cmd"], svc["cwd"], svc["log"])
        except Exception as error:
            LOGGER.error("failed to relaunch %s: %s", svc["name"], error)
            continue
        time.sleep(8)
        LOGGER.info("service %s relaunched, check=%s",
                    svc["name"], alive(svc["check"]))


def main() -> None:
    LOGGER.info("watchdog started (pid %d), cycle=%ds, services=%s",
                os.getpid(), CYCLE_SECONDS, [s["name"] for s in SERVICES])
    while True:
        check_cycle()
        time.sleep(CYCLE_SECONDS)


if __name__ == "__main__":
    main()
