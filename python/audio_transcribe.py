#!/usr/bin/env python3
"""
Transcribe audio files using Gemini API.

This script accepts an input audio file and an output directory.

Usage:
    python audio_transcribe.py --input path/to/audio.mp3 --output_dir path/to/output
"""

import os
import argparse
import logging
import google.generativeai as genai
from jinja2 import Template
import re

def timestamp_to_seconds(ts_str):
    """
    Converts an HH:MM:SS or MM:SS timestamp string to total seconds.
    """
    try:
        ts_str = ts_str.split('.')[0]
        parts = list(map(int, ts_str.split(':')))
        if len(parts) == 3:
            h, m, s = parts
            return h * 3600 + m * 60 + s
        elif len(parts) == 2:
            m, s = parts
            return m * 60 + s
    except Exception:
        pass
    return None

def seconds_to_timestamp(total_seconds):
    """
    Converts total seconds to HH:MM:SS.
    """
    if total_seconds is None or total_seconds < 0:
        total_seconds = 0
    hours, remainder = divmod(int(total_seconds), 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}"

def process_transcript(input_text, max_segment_duration=30):
    """
    Joins transcript lines by speaker and timestamp rules.
    """
    lines = input_text.strip().splitlines()
    output = []
    current_start_ts = None
    current_start_sec = None
    current_speaker = None
    parts = []
    regex = re.compile(r'^\[((?:\d{2}:)?\d{2}:\d{2}(?:\.\d+)?)\]\s*([^:]+?):\s*(.*)$')

    for line in lines:
        line = line.strip()
        if not line:
            continue
        m = regex.match(line)
        if not m:
            if current_speaker:
                output.append(f"[{current_start_ts}] {current_speaker}: {' '.join(parts)}")
                current_speaker = None
                parts = []
            output.append(line)
            continue

        ts_str, speaker, text = m.groups()
        sec = timestamp_to_seconds(ts_str)
        if sec is None:
            continue

        new_seg = (
            current_speaker is None or
            speaker != current_speaker or
            (current_start_sec is not None and sec - current_start_sec > max_segment_duration)
        )

        if new_seg:
            if current_speaker:
                output.append(f"[{current_start_ts}] {current_speaker}: {' '.join(parts)}")
            current_start_ts = seconds_to_timestamp(sec)
            current_start_sec = sec
            current_speaker = speaker
            parts = [text]
        else:
            parts.append(text)

    if current_speaker:
        output.append(f"[{current_start_ts}] {current_speaker}: {' '.join(parts)}")

    return "\n".join(output)

def main():
    parser = argparse.ArgumentParser(description='Transcribe audio using Google Gemini API.')
    parser.add_argument('--input',     '-i', required=True, help='Path to the audio file')
    parser.add_argument('--output_dir','-o', required=True, help='Directory to save transcript')
    parser.add_argument('--speakers',  '-s', nargs='+', default=['Speaker1'], help='List of speaker names')
    parser.add_argument('--model',     '-m', required=True, help='Gemini model to use for transcription')
    args = parser.parse_args()

    # Read API key from environment (injected by Electron)
    api_key = os.getenv('GOOGLE_API_KEY')
    if not api_key:
        logging.error('[ERR] API key not set. Please open Settings and enter your Gemini API key.')
        return

    # Configure Gemini SDK
    genai.configure(api_key=api_key)

    # Prepare prompt template
    prompt_tmpl = Template("""Generate a transcript of the episode. Include timestamps and identify speakers.

Speakers are:
{% for speaker in speakers %}- {{ speaker }}{% if not loop.last %}\n{% endif %}{% endfor %}

eg:
[00:00] Speaker1: Hello.
[00:02] Speaker2: Hi.

If music or sound, denote [MUSIC] or similar.
Signify end with [END].
Do not use Markdown formatting.
Only English alphabet characters.
Ensure correct spelling.
""")
    prompt = prompt_tmpl.render(speakers=args.speakers)

    # Upload audio file
    uploaded = genai.upload_file(args.input)

    # Generate transcription using the chosen model
    model = genai.GenerativeModel(args.model)
    response = model.generate_content(contents=[prompt, uploaded])
    raw_text = response.text

    # Post-process and save
    processed = process_transcript(raw_text)
    os.makedirs(args.output_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.input))[0]
    out_path = os.path.join(args.output_dir, f"{base}_transcript.txt")
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(processed)

    print(f"[OK] Transcript saved to {out_path}")

if __name__ == '__main__':
    main()