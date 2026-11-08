#!/bin/bash
# pull.sh — maximize YouTube audio+caption yield on this server.
# Rotates the whitelisted proxy pool; falls back to the default route.
# Output: ~/ht/audio/<vid>/ (audio + captions.vtt + info.json + dl.log)
cd ~/ht
mkdir -p audio
N_ALIVE=$(wc -l < alive.txt)
[ "$N_ALIVE" -lt 1 ] && { echo "no alive proxies"; exit 1; }
IDX=0
DONE=0
FAIL=0
while read -r VID; do
  [ -z "$VID" ] && continue
  if [ -f "audio/$VID/dl.ok" ]; then continue; fi
  mkdir -p "audio/$VID"
  P=$(sed -n "$(( (IDX % N_ALIVE) + 1 ))p" alive.txt | tr -d '\r')
  IDX=$((IDX+1))
  echo "$(date +%H:%M:%S) pull $VID via ${P##*@}"
  ~/bin/yt-dlp --proxy "$P" --no-playlist --no-warnings --socket-timeout 30 \
    --retries 1 --sleep-requests 1.5 \
    --extractor-args "youtube:player_client=tv_embedded" \
    --write-auto-subs --write-subs --sub-langs "en.*" --sub-format vtt \
    --write-info-json -f "bestaudio[abr<=64]/bestaudio" \
    -o "audio/$VID/%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v=$VID" \
    > "audio/$VID/dl.log" 2>&1
  if [ $? -eq 0 ]; then
    touch "audio/$VID/dl.ok"; DONE=$((DONE+1))
    echo "$(date +%H:%M:%S) OK $VID ($DONE done, $FAIL fail)"
    sleep 2
    continue
  fi
  # retry once via the server default route (no --proxy)
  ~/bin/yt-dlp --no-playlist --no-warnings --socket-timeout 30 \
    --retries 1 --sleep-requests 1.5 \
    --extractor-args "youtube:player_client=tv_embedded" \
    --write-auto-subs --write-subs --sub-langs "en.*" --sub-format vtt \
    --write-info-json -f "bestaudio[abr<=64]/bestaudio" \
    -o "audio/$VID/%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v=$VID" \
    >> "audio/$VID/dl.log" 2>&1
  if [ $? -eq 0 ]; then
    touch "audio/$VID/dl.ok"; DONE=$((DONE+1))
    echo "$(date +%H:%M:%S) OK(default) $VID ($DONE done, $FAIL fail)"
  else
    FAIL=$((FAIL+1))
    echo "$(date +%H:%M:%S) FAIL $VID ($DONE done, $FAIL fail)"
  fi
  sleep 2
done < pending.txt
echo "$(date +%H:%M:%S) ALL DONE: $DONE ok, $FAIL fail"
