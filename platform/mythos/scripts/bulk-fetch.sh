#!/usr/bin/env bash
# Bulk-fetch URLs from a TSV manifest: slug<TAB>url
# Output: /tmp/kb-fetch/<slug>.{html,pdf,md,txt} + fetch-log.txt

set -u
MANIFEST="${1:?usage: bulk-fetch.sh <manifest.tsv>}"
OUT="/tmp/kb-fetch"
mkdir -p "$OUT"
LOG="$OUT/fetch-log.txt"
: > "$LOG"

fetch_one() {
  local slug="$1" url="$2"
  local ext="html"
  [[ "$url" == *.pdf ]] && ext="pdf"
  [[ "$url" == *.md ]] && ext="md"
  local dest="$OUT/${slug}.${ext}"
  local code
  code=$(curl -sL --max-time 30 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
    -w "%{http_code}" -o "$dest" "$url" 2>/dev/null) || code="000"
  local size=$(wc -c < "$dest" 2>/dev/null | tr -d ' ' || echo 0)
  echo -e "${slug}\t${code}\t${size}\t${url}" >> "$LOG"
  if [[ "$code" == "200" && "$size" -gt 500 ]]; then
    echo "OK  $slug ($size bytes)"
  else
    echo "FAIL $slug code=$code size=$size"
  fi
}

export -f fetch_one
export OUT LOG

# Parallel with xargs -P 8
awk -F'\t' 'NF==2{print $0}' "$MANIFEST" | while IFS=$'\t' read -r slug url; do
  echo -e "${slug}\t${url}"
done | xargs -n 2 -P 8 bash -c 'fetch_one "$0" "$1"'
