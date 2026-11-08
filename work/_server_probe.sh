#!/usr/bin/env bash
# Read-only probe: server downloads route through the LOCAL Clash proxy via ssh -R.
PROXY="http://127.0.0.1:7890"
echo "=== OS ==="
. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo "=== python / yt-dlp / ffmpeg ==="
python3 --version 2>&1
command -v yt-dlp || echo "no yt-dlp binary"
python3 -m yt_dlp --version 2>&1 | head -1
command -v ffmpeg || echo "no ffmpeg"
echo "=== home / existing checkout ==="
ls ~ | head -30
find ~ -maxdepth 3 -iname "*hackertube*" -type d 2>/dev/null | head
echo "=== YouTube via LOCAL proxy (tunnel) ==="
curl -sS -m 25 -x "$PROXY" -o /dev/null -w "youtube generate_204 -> HTTP %{http_code}, time %{time_total}s\n" https://www.youtube.com/generate_204 2>&1 | tail -2
echo "=== egress IP via LOCAL proxy (should be the local node exit) ==="
curl -sS -m 25 -x "$PROXY" https://ipinfo.io/json 2>&1 | head -15
echo "=== DONE ==="