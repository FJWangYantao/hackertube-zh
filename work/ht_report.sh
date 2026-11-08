#!/bin/bash
# 建库进度汇报:tencent 走 SSH,本机直读,拼成微信摘要
collect() {
  log="$1/dl_stdout.log"
  state=$(systemctl is-active hackertube-builder 2>/dev/null)
  [ -z "$state" ] && state=down
  win=$(date -d '3 hours ago' '+%m-%d %H:%M')
  recent=$(awk -v s="$win" '{if ($1" "$2 >= s) print}' "$log" 2>/dev/null)
  ok=$(printf '%s
' "$recent" | grep -c ' OK '); ok=${ok:-0}
  caps=$(printf '%s
' "$recent" | grep -c ' CAPS '); caps=${caps:-0}
  fail=$(printf '%s
' "$recent" | grep -c ' FAIL '); fail=${fail:-0}
  vids=$(ls "$1/yt_audio" 2>/dev/null | wc -l)
  size=$(du -sh "$1/yt_audio" 2>/dev/null | cut -f1)
  disk=$(df -h / | tail -1 | awk '{print $4}')
  last=$(tail -1 "$log" 2>/dev/null | cut -c1-60)
  failbrk=$(printf '%s
' "$recent" | grep ' FAIL ' | grep -oE '\[[^]]+\]' | sort | uniq -c | sort -rn | awk '{printf "%s%s ", $2, $1}' | cut -c1-70)
  echo "$state|$ok|$caps|$fail|$vids|$size|$disk|$last|$failbrk"
}
T=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
    "ubuntu@${HT_VPS_HOST:?set HT_VPS_HOST}" "$(declare -f collect); collect \$HOME" 2>/dev/null)
H=$(collect "$HOME")
fmt() { IFS='|' read -r st ok caps fail vids size disk last failbrk <<< "$1"
  [ "$st" = "active" ] && emoji="▶️" || emoji="⏸️"
  echo "$emoji $2: $st | 音频$ok 字幕$caps 失败$fail | 库$vids个($size) | 剩$disk"
  [ -n "$last" ] && echo "   └ $last"
  [ -n "$failbrk" ] && echo "   ⚠ 失败分布: $failbrk"; }
echo "📡 黑客频道建库进度 $(date '+%m-%d %H:%M')"
fmt "$T" "tencent"
fmt "$H" "hermes"
tv=$(echo "$T" | cut -d'|' -f5); hv=$(echo "$H" | cut -d'|' -f5)
echo "📚 合计入档: $(( ${tv:-0} + ${hv:-0} )) / 5145"
