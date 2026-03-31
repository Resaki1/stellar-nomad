#!/usr/bin/env bash
# convert-to-ktx2.sh — Convert image textures to KTX2 (Basis Universal UASTC)
#
# Usage:
#   ./scripts/convert-to-ktx2.sh [options] <input_file> [input_file...]
#   ./scripts/convert-to-ktx2.sh --all          Convert all textures in public/textures/
#
# Options:
#   --linear     Treat input as linear (for normal, displacement, specular maps)
#   --all        Batch-convert every .webp/.jpg/.png in public/textures/
#   --help       Show this help
#
# Prerequisites:
#   brew install ktx-software      # provides toktx
#
# Output: .ktx2 file alongside the original (e.g. 8k_mercury.webp → 8k_mercury.ktx2)
#
# Compression: UASTC level 2 + Zstandard supercompression (near-lossless, fast GPU upload).
# Color space: sRGB by default. Use --linear for non-color data (normals, displacement, specular).

set -euo pipefail

# ── Check for toktx ──
if ! command -v toktx &>/dev/null; then
  echo "Error: toktx not found. Install with: brew install ktx-software" >&2
  exit 1
fi

LINEAR=false
BATCH=false
FILES=()

for arg in "$@"; do
  case "$arg" in
    --linear) LINEAR=true ;;
    --all)    BATCH=true ;;
    --help|-h)
      head -16 "$0" | tail -15
      exit 0
      ;;
    *) FILES+=("$arg") ;;
  esac
done

# ── Known linear textures (auto-detected in batch mode) ──
is_linear_texture() {
  local f="$1"
  case "$f" in
    *normal*|*displacement*|*specular*) return 0 ;;
    *) return 1 ;;
  esac
}

convert_one() {
  local input="$1"
  local use_linear="$2"

  if [[ ! -f "$input" ]]; then
    echo "Skip: $input (not found)" >&2
    return
  fi

  local dir ext base output
  dir="$(dirname "$input")"
  ext="${input##*.}"
  base="${input%.*}"
  output="${base}.ktx2"

  if [[ -f "$output" && "$output" -nt "$input" ]]; then
    echo "Skip: $output (up to date)"
    return
  fi

  # toktx needs PNG or JPEG as input. Convert WebP via sips (macOS built-in).
  local tmpfile=""
  local src="$input"
  if [[ "$ext" == "webp" ]]; then
    tmpfile="$(mktemp /tmp/ktx2_XXXXXX.png)"
    sips -s format png "$input" --out "$tmpfile" >/dev/null 2>&1
    src="$tmpfile"
  fi

  # UASTC/ASTC block compression requires dimensions divisible by 4.
  # Resize to nearest multiple-of-4 if needed.
  local w h
  w=$(sips -g pixelWidth "$src" 2>/dev/null | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$src" 2>/dev/null | awk '/pixelHeight/{print $2}')
  if (( w % 4 != 0 || h % 4 != 0 )); then
    local nw=$(( (w + 3) / 4 * 4 ))
    local nh=$(( (h + 3) / 4 * 4 ))
    echo "  Resizing ${w}x${h} → ${nw}x${nh} (must be multiple of 4)"
    if [[ -z "$tmpfile" ]]; then
      tmpfile="$(mktemp /tmp/ktx2_XXXXXX.png)"
      sips -s format png "$src" --out "$tmpfile" >/dev/null 2>&1
    fi
    sips -z "$nh" "$nw" "$tmpfile" >/dev/null 2>&1
    src="$tmpfile"
  fi

  # Build toktx args
  local args=(
    --t2                        # Output KTX2
    --encode uastc              # UASTC compression (near-lossless)
    --uastc_quality 2           # Quality level 2 (good balance)
    --zcmp 19                   # Zstandard supercompression level
    --genmipmap                 # Generate mipmaps
  )

  if [[ "$use_linear" == "true" ]]; then
    args+=(--assign_oetf linear)
  else
    args+=(--assign_oetf srgb)
  fi

  echo "Convert: $input → $output $([ "$use_linear" = true ] && echo '[linear]' || echo '[sRGB]')"
  toktx "${args[@]}" "$output" "$src"

  # Clean up temp file
  [[ -n "$tmpfile" ]] && rm -f "$tmpfile"
}

# ── Batch mode: find all textures ──
if [[ "$BATCH" == "true" ]]; then
  echo "Batch converting all textures in public/textures/..."
  while IFS= read -r -d '' file; do
    if is_linear_texture "$file"; then
      convert_one "$file" true
    else
      convert_one "$file" false
    fi
  done < <(find public/textures -type f \( -name '*.webp' -o -name '*.jpg' -o -name '*.png' \) -print0 | sort -z)

  # Also handle Earth's clouds as linear (not auto-detected by name)
  for f in public/textures/earth_clouds_8k.webp public/textures/earth_clouds_2k.webp; do
    [[ -f "$f" ]] && convert_one "$f" true
  done

  echo "Done! Convert complete."
  exit 0
fi

# ── Single file mode ──
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "Usage: $0 [--linear] [--all] <input_file> [input_file...]" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  convert_one "$f" "$LINEAR"
done
