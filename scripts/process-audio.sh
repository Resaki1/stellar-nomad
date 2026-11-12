#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AUDIO ASSET PIPELINE — docs/AUDIO_PLAN.md §6.8.
#
# Takes a raw source file (WAV/MP3/FLAC/AIFF/anything ffmpeg reads) and produces
# a game-ready .opus in the right place, with the right channel count and the
# right loudness. Follows the precedent of scripts/convert-to-ktx2.sh.
#
#   ./scripts/process-audio.sh --sfx3d raw/impact_rock_01.wav
#   ./scripts/process-audio.sh --sfx2d raw/ui_confirm.wav
#   ./scripts/process-audio.sh --music raw/ambient_drift.wav
#   ./scripts/process-audio.sh --all-in raw/impacts --sfx3d
#
# Requires: ffmpeg (brew install ffmpeg).
#
# ⚠⚠ THE MONO RULE IS NOT A SIZE OPTIMISATION. Feeding a STEREO buffer into a
# PannerNode makes Web Audio silently switch to stereo-to-stereo upmixing, which
# smears the directional cue instead of erroring. It does not throw. It just
# sounds vaguely wrong forever. `--sfx3d` therefore force-downmixes to mono, and
# `pnpm check:audio` fails the build if a world-tier asset is not mono.
#
# ⚠ TWO LOUDNESS NUMBERS, TWO DIFFERENT STAGES. Do not apply either twice:
#     -16 LUFS  per ASSET, here, before it enters the manifest
#     -18..-20 LUFS  on the MASTER BUS at runtime, after all buses mix
# ---------------------------------------------------------------------------
set -euo pipefail

SFX_LUFS="-16"
MUSIC_LUFS="-18"
TRUE_PEAK="-1.5"
LRA="11"

usage() {
  cat <<'USAGE'
usage: process-audio.sh <kind> <file...>
       process-audio.sh --all-in <dir> <kind>

  kinds:
    --sfx2d      UI / ship-diegetic. Stereo preserved. 96 kbps.  -> public/audio/sfx2d/
    --sfx3d      World emitters. FORCE MONO (see header). 96 kbps. -> public/audio/sfx3d/
    --ambience   Beds. Stereo. 96 kbps.                         -> public/audio/ambience/
    --music      Streamed tracks. Stereo. 160 kbps, -18 LUFS.    -> public/audio/music/
    --voice      Spoken/chirp. Mono. 64 kbps.                    -> public/audio/voice/

  options:
    --no-trim    skip silence trimming and edge fades
    --dry-run    print what would happen
USAGE
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }
have ffmpeg || { echo "ffmpeg not found. brew install ffmpeg" >&2; exit 1; }

KIND=""; DRY=0; TRIM=1; FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sfx2d|--sfx3d|--ambience|--music|--voice) KIND="${1#--}"; shift ;;
    --no-trim) TRIM=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --all-in) shift; SRC_DIR="${1:?--all-in needs a directory}"; shift
              while IFS= read -r f; do FILES+=("$f"); done \
                < <(find "$SRC_DIR" -type f \( -iname '*.wav' -o -iname '*.mp3' -o -iname '*.flac' -o -iname '*.aif' -o -iname '*.aiff' -o -iname '*.ogg' -o -iname '*.m4a' \) | sort) ;;
    -h|--help) usage ;;
    *) FILES+=("$1"); shift ;;
  esac
done
[[ -n "$KIND" ]] || usage
[[ ${#FILES[@]} -gt 0 ]] || usage

case "$KIND" in
  sfx2d)    OUT_DIR="public/audio/sfx2d";    CHANNELS=""; BITRATE="96k";  TARGET="$SFX_LUFS" ;;
  sfx3d)    OUT_DIR="public/audio/sfx3d";    CHANNELS="1"; BITRATE="96k";  TARGET="$SFX_LUFS" ;;
  ambience) OUT_DIR="public/audio/ambience"; CHANNELS=""; BITRATE="96k";  TARGET="$SFX_LUFS" ;;
  music)    OUT_DIR="public/audio/music";    CHANNELS=""; BITRATE="160k"; TARGET="$MUSIC_LUFS" ;;
  voice)    OUT_DIR="public/audio/voice";    CHANNELS="1"; BITRATE="64k";  TARGET="$SFX_LUFS" ;;
esac

TMP="${TMPDIR:-/tmp}/sn-audio-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "kind=$KIND  ->  $OUT_DIR   target ${TARGET} LUFS, TP ${TRUE_PEAK} dBTP, ${BITRATE}${CHANNELS:+, mono}"
mkdir -p "$OUT_DIR"

for SRC in "${FILES[@]}"; do
  [[ -f "$SRC" ]] || { echo "  skip (not a file): $SRC"; continue; }
  BASE="$(basename "${SRC%.*}")"
  # Lowercase, non-alphanumerics to underscore — the manifest references these
  # paths as string literals, so surprises in filenames are surprises in code.
  SAFE="$(echo "$BASE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')"
  OUT="$OUT_DIR/$SAFE.opus"

  if [[ $DRY -eq 1 ]]; then echo "  $SRC -> $OUT"; continue; fi

  # ── 1. decode to a working WAV, optionally trimming + fading ───────────
  # Edge fades are not cosmetic: a non-zero first or last sample is an audible
  # click on EVERY play, and it is the single most common avoidable defect in a
  # hand-assembled SFX set.
  FILTERS=""
  if [[ $TRIM -eq 1 && "$KIND" != "music" ]]; then
    FILTERS="silenceremove=start_periods=1:start_silence=0:start_threshold=-60dB,areverse,silenceremove=start_periods=1:start_silence=0:start_threshold=-60dB,areverse,afade=t=in:st=0:d=0.004"
  fi
  ffmpeg -y -hide_banner -loglevel error -i "$SRC" \
    ${CHANNELS:+-ac "$CHANNELS"} \
    ${FILTERS:+-af "$FILTERS"} \
    -ar 48000 "$TMP/step1.wav"

  # ── 2. two-pass loudnorm ───────────────────────────────────────────────
  # Pass 1 MEASURES, pass 2 APPLIES with the measurements fed back in.
  # ⚠ A single pass is not equivalent: one-pass loudnorm is a dynamic
  # normaliser and will pump. `linear=true` in pass 2 applies ONE constant gain,
  # which is what "match the levels" actually means.
  MEASURE="$(ffmpeg -hide_banner -i "$TMP/step1.wav" \
    -af "loudnorm=I=$TARGET:TP=$TRUE_PEAK:LRA=$LRA:print_format=json" \
    -f null - 2>&1 || true)"

  # Strip quotes wholesale rather than trying to match them: loudnorm prints
  # `"input_i" : "-38.25",` and a regex that tries to be clever about the closing
  # quote leaves it attached, which ffmpeg then rejects as an invalid option.
  get() { echo "$MEASURE" | grep -o "\"$1\"[^,}]*" | tail -1 | tr -d '"' | sed -E 's/.*:[[:space:]]*//'; }
  I_IN="$(get input_i)"; TP_IN="$(get input_tp)"
  LRA_IN="$(get input_lra)"; THRESH_IN="$(get input_thresh)"
  OFFSET="$(get target_offset)"

  if [[ -z "${I_IN:-}" || "$I_IN" == "-inf" ]]; then
    # Happens on near-silent or very short sources; loudnorm has nothing to
    # measure. Better to pass through than to apply a garbage gain.
    echo "  ! $SAFE: no measurable loudness (silent or <400ms) — encoding without normalisation"
    cp "$TMP/step1.wav" "$TMP/step2.wav"
  else
    ffmpeg -y -hide_banner -loglevel error -i "$TMP/step1.wav" \
      -af "loudnorm=I=$TARGET:TP=$TRUE_PEAK:LRA=$LRA:measured_I=$I_IN:measured_TP=$TP_IN:measured_LRA=$LRA_IN:measured_thresh=$THRESH_IN:offset=$OFFSET:linear=true" \
      "$TMP/step2.wav"
  fi

  # ── 3. encode ──────────────────────────────────────────────────────────
  ffmpeg -y -hide_banner -loglevel error -i "$TMP/step2.wav" \
    -c:a libopus -b:a "$BITRATE" -vbr on -compression_level 10 \
    -application audio "$OUT"

  # ── 4. report what actually came out ───────────────────────────────────
  VERIFY="$(ffmpeg -hide_banner -i "$OUT" -af ebur128 -f null - 2>&1 | tail -20)"
  I_OUT="$(echo "$VERIFY" | grep -E '^\s*I:' | tail -1 | grep -oE '\-?[0-9.]+' | head -1)"
  CH="$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$OUT")"
  DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
  KB="$(( $(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT") / 1024 ))"
  printf "  %-34s %sch %6.2fs %4dKB  %s LUFS\n" "$SAFE.opus" "$CH" "$DUR" "$KB" "${I_OUT:-?}"
done

echo
echo "Now: add each file to AUDIO_EVENTS in src/data/audioEvents.ts, then run"
echo "  pnpm check:audio"
echo "and log any CC-BY / attribution-required source in CREDITS.md."
