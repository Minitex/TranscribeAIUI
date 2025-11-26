#!/usr/bin/env python3
"""
Transcribe audio files using Gemini API.

If the audio is longer than 1 hour (and --subtitles is NOT used), the script will:
  • Convert non-MP3 input to MP3
  • Split it into two halves (part1.mp3 and part2.mp3)
  • Transcribe each half separately to part1.txt and part2.txt
  • Remove any trailing "[END]" marker from part 1 only
  • Shift ALL timestamps in part 2 forward by the ACTUAL duration of part 1
  • Produce a combined transcript base.txt = part1 + shifted(part2) without dropping lines
  • In **default mode only** (no --interview, no --subtitles), clean up split MP3s and part TXT files after combining

Requires GOOGLE_API_KEY env var.
"""

import os
import sys
import argparse
import logging
import subprocess
import re
import json

import google.generativeai as genai
from jinja2 import Template
from imageio_ffmpeg import get_ffmpeg_exe

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
PRETTY_WRAP_WIDTH = 100

# ----------------------------- FFMPEG helpers ------------------------------ #

def ffmpeg_path() -> str:
    """Return the path to the statically bundled ffmpeg executable (imageio-ffmpeg)."""
    exe = get_ffmpeg_exe()
    if getattr(sys, "frozen", False):
        name = os.path.basename(exe)
        return os.path.join(sys._MEIPASS, name)
    return exe


def run_ffmpeg(args: list[str]) -> None:
    """Run ffmpeg with provided args (stdout/stderr suppressed unless error)."""
    cmd = [ffmpeg_path(), *args]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def probe_duration_seconds(path: str) -> float:
    """Use `ffmpeg -i` stderr to parse `Duration: HH:MM:SS.xx` and return seconds."""
    res = subprocess.run([ffmpeg_path(), '-i', path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', res.stderr)
    if not m:
        return 0.0
    h, mm, ss, ms = m.groups()
    frac = float(f"0.{ms}") if ms else 0.0
    return int(h) * 3600 + int(mm) * 60 + int(ss) + frac

# ----------------------------- Transcript / text utils -------------------- #

def strip_code_fence(s: str) -> str:
    # handle ```srt, ```text, ```json, or plain ```
    s = re.sub(r'^```(?:\w+)?\s*', '', s.strip())
    s = re.sub(r'\s*```$', '', s)
    return s.strip()


def try_parse_speaker_json(raw_text: str):
    cleaned = strip_code_fence(raw_text)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list) and all(isinstance(item, dict) and 'transcription' in item for item in parsed):
            return parsed
    except json.JSONDecodeError:
        return None
    return None


def format_speaker_transcript(entries):
    lines = []
    for entry in entries:
        speaker = entry.get("speaker") or "Unknown"
        text = entry.get("transcription", "")
        text = re.sub(r'\s+', ' ', text).strip()
        lines.append(f"{speaker}: {text}")
        lines.append("")
    if lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def shift_bracket_timestamps(text: str, offset_seconds: float) -> str:
    """Shift timestamps like [MM:SS] or [HH:MM:SS] forward by offset_seconds."""
    if not offset_seconds:
        return text

    def to_seconds(h: int, m: int, s: int) -> int:
        return h * 3600 + m * 60 + s

    def fmt_time(total: float) -> str:
        total = int(round(total))
        h = total // 3600
        rem = total % 3600
        m = rem // 60
        s = rem % 60
        if h > 0:
            return f"{h:02d}:{m:02d}:{s:02d}"
        return f"{m:02d}:{s:02d}"

    def repl(match: re.Match) -> str:
        inside = match.group(1)  # either MM:SS or HH:MM:SS
        parts = [int(p) for p in inside.split(':')]
        if len(parts) == 2:
            h, m, s = 0, parts[0], parts[1]
        else:
            h, m, s = parts
        new_total = to_seconds(h, m, s) + offset_seconds
        return f"[{fmt_time(new_total)}]"

    return re.sub(r"\[(\d{2}:\d{2}(?::\d{2})?)\]", repl, text)


def fix_srt_hours(srt_text: str) -> str:
    """If lines have MM:SS,mmm --> MM:SS,mmm, prefix 00: to each side."""
    return re.sub(
        r'(?m)^(\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2},\d{3})$',
        r'00:\1 --> 00:\2',
        srt_text,
    )


def srt_to_transcript(srt_text: str) -> str:
    """Collapse SRT into readable transcript: every 5 blocks → one line with [HH:MM:SS]."""
    blocks = re.split(r'\n{2,}', srt_text.strip())
    lines = []
    group_size = 5
    for i in range(0, len(blocks), group_size):
        group = blocks[i:i+group_size]
        header = group[0].splitlines()
        if len(header) < 2:
            continue
        start = header[1].split('-->')[0].strip()
        if re.match(r'^\d{2}:\d{2}:\d{2}$', start):
            start += ',000'
        h, m, s_ms = start.split(':')
        s = s_ms.split(',', 1)[0]
        timestamp = f"{int(h):02d}:{int(m):02d}:{int(s):02d}"
        texts = []
        for block in group:
            parts = block.splitlines()
            if len(parts) < 3:
                continue
            texts.append(' '.join(p.strip() for p in parts[2:]))
        lines.append(f"[{timestamp}] {' '.join(texts)}")
    return "\n".join(lines)


def extract_text(resp) -> str:
    """Robustly extract text from a Gemini response (works when resp.text is missing)."""
    # 1) Quick accessor
    try:
        t = resp.text
        if t:
            return t
    except Exception:
        pass

    # 2) Stitch from candidates/parts
    chunks = []
    for cand in getattr(resp, "candidates", []) or []:
        content = getattr(cand, "content", None)
        if not content:
            continue
        parts = getattr(content, "parts", None)
        if not parts:
            continue
        for p in parts:
            if isinstance(p, dict):
                txt = p.get("text")
            else:
                txt = getattr(p, "text", None)
            if txt:
                chunks.append(txt)
    if chunks:
        return "\n".join(chunks)

    # 3) Fallback
    try:
        return str(resp)
    except Exception:
        return ""

# ----------------------------- Main -------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description='Transcribe audio using Gemini API.')
    parser.add_argument('-i','--input', required=True, help='Path to the audio file')
    parser.add_argument('-o','--output_dir', required=True, help='Directory to save outputs')
    parser.add_argument('-m','--model', required=True, help='Gemini model')
    parser.add_argument('--interview', action='store_true', help='Interview-mode prompt')
    parser.add_argument('--subtitles', action='store_true', help='Also generate SRT subtitles')
    args = parser.parse_args()

    api_key = os.getenv('GOOGLE_API_KEY','').strip() or sys.exit(logging.error('GOOGLE_API_KEY not set.'))
    raw_prompt = os.getenv('AUDIO_PROMPT','').strip() or sys.exit(logging.error('AUDIO_PROMPT not set.'))
    prompt = Template(raw_prompt).render()
    genai.configure(api_key=api_key)

    os.makedirs(args.output_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.input))[0]

    # Convert to mp3 if needed (keep track so we can clean up temp file)
    in_path = args.input
    tmp_mp3 = None
    if not in_path.lower().endswith('.mp3'):
        tmp_mp3 = os.path.join(args.output_dir, f"{base}.mp3")
        logging.info(f"[INFO] Converting to mp3: {tmp_mp3}")
        run_ffmpeg(['-y','-i', in_path, '-codec:a','libmp3lame','-qscale:a','2', tmp_mp3])
        in_path = tmp_mp3

    # Build prompt (log what we use)
    prompt_full = prompt
    if args.interview:
        raw_int = os.getenv('INTERVIEW_AUDIO_PROMPT','').strip()
        if raw_int:
            prompt_full = Template(raw_int).render()
    if args.subtitles:
        prompt_full += '\n\nPlease emit a valid SRT subtitle file.'

    # Decide whether to split
    total_duration = probe_duration_seconds(in_path)
    logging.info(f"[INFO] Input duration: {total_duration:.2f}s")

    generated_mp3s = []
    generated_txts = []

    if total_duration > 3600.0 and not args.subtitles and not args.interview:
        logging.info("[INFO] Splitting in half and transcribing parts...")
        half = total_duration / 2

        part1_mp3 = os.path.join(args.output_dir, f"{base}_part1.mp3")
        part2_mp3 = os.path.join(args.output_dir, f"{base}_part2.mp3")
        run_ffmpeg(['-y','-i', in_path, '-ss', '0', '-t', str(half), '-c', 'copy', part1_mp3])
        run_ffmpeg(['-y','-i', in_path, '-ss', str(half), '-c', 'copy', part2_mp3])
        logging.info(f"[OK] Created parts: {part1_mp3} | {part2_mp3}")
        generated_mp3s += [part1_mp3, part2_mp3]

        part1_duration = probe_duration_seconds(part1_mp3)
        logging.info(f"[INFO] Part1 duration (actual): {part1_duration:.2f}s")

        uploaded1 = genai.upload_file(part1_mp3)
        model = genai.GenerativeModel(args.model)
        resp1 = model.generate_content(contents=[prompt_full, uploaded1])
        text1 = extract_text(resp1).replace('[END]', '')
        part1_txt = os.path.join(args.output_dir, f"{base}_part1.txt")
        with open(part1_txt, 'w', encoding='utf-8') as f:
            f.write(text1)
        logging.info(f"[OK] Saved part1 TXT: {part1_txt}")
        generated_txts.append(part1_txt)

        uploaded2 = genai.upload_file(part2_mp3)
        resp2 = model.generate_content(contents=[prompt_full, uploaded2])
        text2_raw = extract_text(resp2)
        text2 = shift_bracket_timestamps(text2_raw, part1_duration)
        part2_txt = os.path.join(args.output_dir, f"{base}_part2.txt")
        with open(part2_txt, 'w', encoding='utf-8') as f:
            f.write(text2)
        logging.info(f"[OK] Saved part2 TXT: {part2_txt}")
        generated_txts.append(part2_txt)

        combined = text1 + ('' if text1.endswith('\n') else '\n') + text2
        combined_txt = os.path.join(args.output_dir, f"{base}.txt")
        with open(combined_txt, 'w', encoding='utf-8') as f:
            f.write(combined)
        logging.info(f"[OK] Saved combined TXT: {combined_txt}")

        # cleanup (default mode only)
        for p in generated_mp3s:
            try:
                os.remove(p)
                logging.info(f"[OK] Removed split mp3: {p}")
            except Exception as e:
                logging.warning(f"[WARN] Failed to remove split mp3 {p}: {e}")

        for t in generated_txts:
            try:
                os.remove(t)
                logging.info(f"[OK] Removed part transcript: {t}")
            except Exception as e:
                logging.warning(f"[WARN] Failed to remove part transcript {t}: {e}")

    else:
        # Single transcription path (used by subtitles AND interview/default for <=1h)
        uploaded = genai.upload_file(in_path)
        model = genai.GenerativeModel(args.model)
        response = model.generate_content(contents=[prompt_full, uploaded])
        raw_text = extract_text(response)

        if args.subtitles:
            # Write SRT + readable TXT derived from SRT
            srt_text = strip_code_fence(raw_text or "")
            srt_text = fix_srt_hours(srt_text)
            srt_path = os.path.join(args.output_dir, f"{base}.srt")
            with open(srt_path, 'w', encoding='utf-8') as f:
                f.write(srt_text)
            logging.info(f"[OK] SRT saved: {srt_path}")

            txt_from_srt = srt_to_transcript(srt_text)
            txt_path = os.path.join(args.output_dir, f"{base}.txt")
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write(txt_from_srt)
            logging.info(f"[OK] Transcript (from SRT) saved: {txt_path}")

        elif args.interview:
            entries = try_parse_speaker_json(raw_text or "")
            if entries:
                pretty = format_speaker_transcript(entries)
                out_text = pretty if pretty.endswith("\n") else pretty + "\n"
                logging.info(f"[OK] Interview JSON parsed: {len(entries)} entries.")
            else:
                out_text = raw_text or ""
                logging.warning("[WARN] Interview mode: expected JSON, saving raw text.")
            out_txt = os.path.join(args.output_dir, f"{base}.txt")
            with open(out_txt, 'w', encoding='utf-8') as f:
                f.write(out_text)
            logging.info(f"[OK] Saved transcript: {out_txt}")

        else:
            out_txt = os.path.join(args.output_dir, f"{base}.txt")
            with open(out_txt, 'w', encoding='utf-8') as f:
                f.write(raw_text or "")
            logging.info(f"[OK] Saved transcript: {out_txt}")

    # Cleanup any temporary MP3 we created from non-MP3 input
    if tmp_mp3:
        try:
            os.remove(tmp_mp3)
            logging.info(f"[OK] Removed temp mp3: {tmp_mp3}")
        except Exception as e:
            logging.warning(f"Failed to remove temp mp3: {e}")

if __name__ == '__main__':
    main()