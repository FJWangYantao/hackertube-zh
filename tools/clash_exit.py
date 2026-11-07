"""Rotate the local Clash/Mihomo exit node when YouTube bot-checks the current one.

Clash for Windows launches its controller on a random port, so the module
reads the secret from ``~/.config/clash/config.yaml`` and sweeps listening
loopback ports for the REST API answering ``/version`` with that secret.
Env overrides: ``CLASH_API`` (exact base URL) and ``CLASH_SECRET``;
``CLASH_GROUP`` biases which selector group rotates.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

LOGGER = logging.getLogger(__name__)
try:
    CONTROLLER_CONFIG = Path.home() / ".config" / "clash" / "config.yaml"
except (RuntimeError, OSError):
    CONTROLLER_CONFIG = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or ".") / ".config" / "clash" / "config.yaml"

SPECIAL_NODES = ("DIRECT", "REJECT", "PASS")
GROUP_BONUS_KEYS = ("选择", "节点", "Proxy", "proxy")


def _secret() -> str:
    if os.environ.get("CLASH_SECRET"):
        return os.environ["CLASH_SECRET"]
    try:
        text = CONTROLLER_CONFIG.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    match = re.search(r'^secret:\s*"?([^"\n]+?)"?\s*$', text, re.M)
    return match.group(1).strip() if match else ""


def _listening_loopback_ports() -> list[int]:
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    ordered, seen = [], set()
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        match = re.search(r"127\.0\.0\.1:(\d+)", line)
        if match:
            port = int(match.group(1))
            if port > 1024 and port not in seen:
                seen.add(port)
                ordered.append(port)
    return ordered


def _candidate_urls() -> list[str]:
    urls = []
    if os.environ.get("CLASH_API"):
        urls.append(os.environ["CLASH_API"].rstrip("/"))
    try:
        text = CONTROLLER_CONFIG.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    match = re.search(r'^external-controller:\s*"?([^"\n]+?)"?\s*$', text, re.M)
    if match:
        urls.append("http://" + match.group(1).strip())
    urls += [f"http://127.0.0.1:{port}" for port in _listening_loopback_ports()]
    return urls


def _request(base: str, secret: str, path: str,
             payload: dict | None = None, method: str | None = None) -> dict | None:
    headers = {"Authorization": f"Bearer {secret}"} if secret else {}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers,
                                 method=method)
    with urllib.request.urlopen(req, timeout=6) as response:
        body = response.read().decode("utf-8", errors="replace")
    return json.loads(body) if body.strip().startswith("{") else None


def _discover(secret: str) -> str | None:
    for base in _candidate_urls():
        try:
            payload = _request(base, secret, "/version")
        except Exception:
            continue
        if isinstance(payload, dict) and "version" in payload:
            return base
    return None


def _pick_group(proxies: dict, hint: str) -> tuple[str, list[str]] | None:
    """Prefer the hinted group, then names like 选择节点/Proxy, then the largest."""
    best, best_score = None, -1
    for name, p in proxies.items():
        if not isinstance(p, dict) or p.get("type") != "Selector":
            continue
        candidates = [c for c in p.get("all", []) if c not in SPECIAL_NODES]
        if len(candidates) < 2:
            continue
        score = len(candidates)
        if hint and hint.lower() in name.lower():
            score += 10000
        elif any(key in name for key in GROUP_BONUS_KEYS):
            score += 100
        if score > best_score:
            best, best_score = (name, candidates), score
    return best


def rotate_exit(hint: str | None = None) -> str | None:
    """Switch the selector group to its next candidate; return the new node name.

    Returns ``None`` when the controller is unreachable or nothing is
    rotatable — callers keep their previous behaviour in that case.
    """
    secret = _secret()
    base = _discover(secret)
    if base is None:
        LOGGER.warning("clash controller not found; exit not rotated")
        return None
    try:
        payload = _request(base, secret, "/proxies")
    except Exception as error:
        LOGGER.warning("clash /proxies failed (%s); exit not rotated", error)
        return None
    picked = _pick_group(payload.get("proxies", {}),
                         hint or os.environ.get("CLASH_GROUP", ""))
    if picked is None:
        LOGGER.warning("no rotatable selector group; exit not rotated")
        return None
    name, candidates = picked
    current = payload["proxies"][name].get("now")
    if current not in candidates:
        current = candidates[0]
    nxt = candidates[(candidates.index(current) + 1) % len(candidates)]
    path = "/proxies/" + urllib.parse.quote(name, safe="")
    try:
        _request(base, secret, path, {"name": nxt}, method="PUT")
    except Exception as error:
        LOGGER.warning("clash switch failed (%s); exit not rotated", error)
        return None
    LOGGER.warning("rotated clash exit %s: %s -> %s", name, current, nxt)
    return nxt
