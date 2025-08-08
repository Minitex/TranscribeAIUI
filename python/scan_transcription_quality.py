#!/usr/bin/env python3
"""
Scan a directory of transcript .txt files and compute the percentage of placeholder tokens
([unsure] and [blank]) relative to total word count in each file.
Outputs a JSON object with two lists:
  "all": list of { "file": filename, "percentage": pct }
  "over": list of those above threshold (if provided).

Usage:
  python3 scan_transcription_quality.py --folder /path/to/txts [--threshold 20]
"""
import sys
import argparse
import json
from pathlib import Path

def compute_placeholder_ratio(text: str) -> float:
    words = text.split()
    total = len(words)
    if total == 0:
        return 0.0
    count = sum(1 for w in words if w in ('[unsure]', '[blank]'))
    return (count / total) * 100

def scan_folder(folder: Path, threshold: float = None):
    all_scores = []
    over_scores = []

    for file_path in sorted(folder.glob('*.txt')):
        try:
            text = file_path.read_text(encoding='utf-8')
        except Exception:
            continue
        pct = compute_placeholder_ratio(text)
        entry = {"file": file_path.name, "percentage": round(pct, 2)}
        all_scores.append(entry)
        if threshold is not None and pct >= threshold:
            over_scores.append(entry)

    output = {"all": all_scores}
    if threshold is not None:
        output["over"] = over_scores

    sys.stdout.write(json.dumps(output, indent=2))

def main():
    parser = argparse.ArgumentParser(
        description='Scan transcripts for [unsure] and [blank] placeholders.'
    )
    parser.add_argument(
        '--folder', '-f', required=True,
        help='Directory containing .txt transcripts to scan'
    )
    parser.add_argument(
        '--threshold', '-t', type=float,
        help='Percentage threshold to flag files (e.g. 20%)'
    )
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        sys.stdout.write(json.dumps({"error": f"Folder not found: {args.folder}"}))
        sys.exit(1)

    scan_folder(folder, args.threshold)

if __name__ == '__main__':
    main()