#!/usr/bin/env python3
"""
Scan a directory of transcript .txt files, strip common conversational wrappers that AIs add,
and compute a confidence score based on how many placeholder tokens ([unsure] and [blank])
remain in each file (100 = no placeholders, 0 = all placeholders).
Outputs a JSON object with two lists:
  "all": list of {
      "file": filename,
      "confidence": pct,
      "remove_intro_text": removed intro string (optional),
      "remove_outro_text": removed outro string (optional)
    }
  "over": list of those at or below threshold (if provided).

Usage:
  python3 transcript_quality_check.py --folder /path/to/txts [--threshold 20] [--apply-remediation]
"""
import sys
import argparse
import json
import re
from collections import Counter
from pathlib import Path

INTRO_TRIGGERS = [
    "okay, here is the transcription of the text from the image",
    "okay, here is the transcription of the text",
    "here is the transcription of the text",
    "here is the text transcription",
    "here is the transcription",
    "here is the text from the image",
    "the transcription from the image is"
]

OUTRO_TRIGGERS = [
    "thank you, would you like me to transcribe another image",
    "thank you, anything else you need",
    "thank you, anything else i can help with",
    "there you go, what else would you like me to do",
    "there you go, anything else you need",
    "let me know if you need anything else",
    "let me know if you need me to transcribe another one",
    "let me know if you need me to transcribe another",
    "let me know if you need me to transcribe another image",
    "please attach more files if you want me to transcribe",
    "please attach more files if you want me to transcribe another image",
    "please attach more files if you want me to continue"
]

_LEADING_STRIP = "\ufeff \t\r\n\"'“”‘’"
_TRAILING_STRIP = "\ufeff \t\r\n\"'“”‘’"
_TRAILING_PUNCT = "!?.,-"
_TOKEN_RE = re.compile(r"\w+")
_PLACEHOLDER_TOKEN_RE = re.compile(r"(\[(?:unsure|blank)\])", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"(```|~~~)")
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_MAX_PREFIX_CHARS = 200
_MAX_SUFFIX_CHARS = 200
_MAX_HEURISTIC_CHARS = 240
_MAX_HEURISTIC_LINES = 3

_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")

INTRO_KEYWORDS = {
    "transcription",
    "transcribe",
    "transcribed",
    "text",
    "document",
    "image",
    "page",
    "content"
}

INTRO_LEADS = {
    "ok",
    "okay",
    "sure",
    "alright",
    "hello",
    "hi",
    "hey",
    "greetings",
    "here",
    "this",
    "let",
    "i",
    "we"
}

OUTRO_KEYWORDS = {
    "anything",
    "else",
    "another",
    "need",
    "more",
    "help",
    "assist",
    "support",
    "transcribe"
}

OUTRO_POLITE = {
    "thanks",
    "thank",
    "appreciate",
    "happy",
    "glad",
    "let",
    "feel",
    "please",
    "ready"
}


def _tokenize_with_pos(text: str):
    return list(_TOKEN_RE.finditer(text))


def _tokens_from_phrase(phrase: str):
    return re.findall(r"\w+", phrase.lower())

def _normalize_tokens(segment: str):
    return _TOKEN_RE.findall(segment.lower())

def _looks_like_intro(segment: str) -> bool:
    segment = segment.strip()
    if not segment:
        return False
    if len(segment) > _MAX_HEURISTIC_CHARS:
        return False
    lower = segment.lower()
    tokens = set(_normalize_tokens(segment))
    if not tokens:
        return False
    if any(phrase in lower for phrase in [
        "here is the transcription",
        "here's the transcription",
        "here is your transcript",
        "here's your transcript",
        "this is the transcription",
        "this is your transcript",
        "let me transcribe",
        "i will transcribe",
        "i can provide",
        "allow me to transcribe",
        "here is the text from",
        "here's the text from"
    ]):
        return True
    has_transcription_word = any(word in lower for word in ["transcription", "transcribe", "transcribed"])
    has_text_context = any(phrase in lower for phrase in ["text from the image", "text from this image", "the text from the", "the text of the"])
    has_colon = lower.endswith(":")
    if not (has_transcription_word or has_text_context or has_colon):
        return False
    if tokens.intersection(INTRO_LEADS) or any(word in lower for word in [
        "here is", "this is", "your transcript", "let me", "allow me",
        "i will", "i'm going to", "providing you with", "presenting"
    ]):
        return True
    if any(phrase in lower for phrase in [
        "the image is blurry",
        "i can't read",
        "cannot read",
        "unable to transcribe",
        "can't transcribe"
    ]):
        return True
    return False

def _looks_like_outro(segment: str) -> bool:
    segment = segment.strip()
    if not segment:
        return False
    if len(segment) > _MAX_HEURISTIC_CHARS:
        return False
    lower = segment.lower()
    tokens = set(_normalize_tokens(segment))
    if not tokens:
        return False
    if any(phrase in lower for phrase in [
        "let me know if you need",
        "anything else i can",
        "anything else you need",
        "would you like me to",
        "can i help with anything else",
        "need me to transcribe another",
        "feel free to ask",
        "happy to help further",
        "here if you need more"
    ]):
        return True
    if "anything else" in lower and any(word in lower for word in ["transcribe", "need", "want me to", "you would like me to", "i can"]):
        return True
    if (tokens.intersection(OUTRO_POLITE) and tokens.intersection(OUTRO_KEYWORDS)):
        return True
    if "?" in segment and any(phrase in lower for phrase in ["anything else", "need"]):
        return True
    return False

def _gather_lines_with_offsets(text: str):
    lines = text.splitlines(True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    return lines, offsets


def _has_heavy_repetition(text: str) -> bool:
    """
    Backwards-compatible helper retained for callers that expect a boolean flag.
    """
    ratio = compute_repetition_ratio(text)
    return ratio >= 0.2


def compute_repetition_ratio(text: str) -> float:
    """
    Estimate how much of the transcript appears duplicated by looking at repeating lines
    and common n-grams. Returns a ratio between 0 and 1.
    """
    if not text:
        return 0.0

    lines = [ln.strip().lower() for ln in text.splitlines() if ln.strip()]
    line_ratio = 0.0
    if lines:
        line_counts = Counter(lines)
        repeated_lines = sum(count for count in line_counts.values() if count > 1)
        line_ratio = repeated_lines / len(lines)

    words = re.findall(r"\w+", text.lower())
    ngram_ratio = 0.0
    window = 8
    if len(words) >= window * 2:
        ngrams = Counter(
            " ".join(words[i:i + window])
            for i in range(len(words) - window + 1)
        )
        repeated_windows = sum(count - 1 for count in ngrams.values() if count > 1)
        total_windows = max(len(words) - window + 1, 1)
        ngram_ratio = repeated_windows / total_windows

    return max(0.0, min(1.0, max(line_ratio, ngram_ratio)))

def _detect_intro_heuristic(text: str) -> str:
    lines, offsets = _gather_lines_with_offsets(text)
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx >= len(lines):
        return ""
    segment = lines[idx].strip(_LEADING_STRIP + _TRAILING_STRIP)
    if not _looks_like_intro(segment):
        return ""
    start_offset = offsets[idx]
    k = idx - 1
    while k >= 0 and not lines[k].strip():
        start_offset = offsets[k]
        k -= 1
    end_offset = offsets[idx + 1]
    j = idx + 1
    while j < len(lines) and not lines[j].strip():
        end_offset = offsets[j + 1]
        j += 1
    return text[start_offset:end_offset]
    return ""

def _detect_outro_heuristic(text: str) -> str:
    lines, offsets = _gather_lines_with_offsets(text)
    idx = len(lines) - 1
    while idx >= 0 and not lines[idx].strip():
        idx -= 1
    if idx < 0:
        return ""
    segment = lines[idx].strip(_LEADING_STRIP + _TRAILING_STRIP)
    inner_lines = [ln.strip() for ln in lines if ln.strip()]
    if len(inner_lines) <= 1:
        return ""
    if not _looks_like_outro(segment):
        return ""
    start_offset = offsets[idx]
    k = idx - 1
    while k >= 0 and not lines[k].strip():
        start_offset = offsets[k]
        k -= 1
    end_offset = offsets[idx + 1]
    m = idx + 1
    while m < len(lines) and not lines[m].strip():
        end_offset = offsets[m + 1]
        m += 1
    return text[start_offset:end_offset]
    return ""

def find_prefix(text: str, phrases):
    tokens_with_pos = _tokenize_with_pos(text)
    for phrase in phrases:
        phrase_tokens = _tokens_from_phrase(phrase)
        if not phrase_tokens:
            continue
        j = 0
        first_idx = None
        last_end = None
        for token_match in tokens_with_pos:
            if token_match.start() > _MAX_PREFIX_CHARS:
                break
            token_str = token_match.group().lower()
            if token_str == phrase_tokens[j]:
                if first_idx is None:
                    if text[:token_match.start()].strip(_LEADING_STRIP):
                        break
                    first_idx = token_match.start()
                j += 1
                last_end = token_match.end()
                if j == len(phrase_tokens):
                    end = last_end
                    while end < len(text) and text[end] in (_LEADING_STRIP + _TRAILING_PUNCT + ":;"):
                        end += 1
                    return text[:end]
        # try next phrase
    return ""


def find_suffix(text: str, phrases):
    tokens_with_pos = _tokenize_with_pos(text)
    text_len = len(text)
    for phrase in phrases:
        phrase_tokens = _tokens_from_phrase(phrase)
        if not phrase_tokens:
            continue
        j = len(phrase_tokens) - 1
        match_start = None
        match_end = None
        for token_match in reversed(tokens_with_pos):
            if text_len - token_match.end() > _MAX_SUFFIX_CHARS:
                break
            token_str = token_match.group().lower()
            if token_str == phrase_tokens[j]:
                if match_end is None:
                    match_end = token_match.end()
                match_start = token_match.start()
                j -= 1
                if j < 0:
                    tail = text[match_end:]
                    tail_stripped = tail.strip(_TRAILING_STRIP)
                    if tail_stripped:
                        if "\n" in tail_stripped or len(tail_stripped) > 120 or len(_TOKEN_RE.findall(tail_stripped)) > 16:
                            break
                    if match_start is None:
                        continue
                    start = match_start
                    while start > 0 and text[start - 1] in (_LEADING_STRIP + _TRAILING_PUNCT + ":;"):
                        start -= 1
                    return text[start:].rstrip(_TRAILING_STRIP)
        # try next phrase
    return ""

def _strip_markdown_artifacts(text: str) -> str:
    """
    Remove lightweight markdown artifacts (images, headings, emphasis) so transcripts stay plain text.
    """
    if not text:
        return ""
    cleaned = text
    cleaned = _MD_IMAGE_RE.sub("", cleaned)
    cleaned = _MD_LINK_RE.sub(r"\1", cleaned)
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s+", "", cleaned, flags=re.MULTILINE)
    for marker in ("**", "__", "*", "_", "`"):
        cleaned = cleaned.replace(marker, "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def strip_ai_wrapping(text: str):
    """
    Remove common conversational prefixes/suffixes inserted by assistant-style transcripts.
    """
    intro_text = find_prefix(text, INTRO_TRIGGERS)
    if not intro_text:
        intro_text = _detect_intro_heuristic(text)

    cleaned = text
    if intro_text.strip():
        cleaned = cleaned[len(intro_text):].lstrip("\ufeff \t\r\n\"'“”‘’")
    else:
        intro_text = ""

    outro_text = find_suffix(cleaned, OUTRO_TRIGGERS)
    if not outro_text:
        outro_text = _detect_outro_heuristic(cleaned)

    if outro_text.strip():
        cleaned = cleaned[:-len(outro_text)]
        cleaned = cleaned.rstrip("\ufeff \t\r\n\"'“”‘’")
    else:
        outro_text = ""

    cleaned = _strip_markdown_artifacts(cleaned)

    return cleaned, intro_text, outro_text


def compute_confidence(text: str) -> float:
    placeholder_ratio, _, _ = compute_placeholder_stats(text)
    repetition_ratio = compute_repetition_ratio(text)
    bad_ratio = min(1.0, placeholder_ratio + repetition_ratio)
    confidence = (1.0 - bad_ratio) * 100
    return confidence


def compute_placeholder_stats(text: str):
    normalized = _PLACEHOLDER_TOKEN_RE.sub(r" \1 ", text)
    words = normalized.split()
    total = len(words)
    if total == 0:
        return 0.0, 0, 0
    count = sum(1 for w in words if w.lower() in ('[unsure]', '[blank]'))
    ratio = count / total
    return ratio, count, total


def detect_markdown_artifacts(text: str):
    if not text:
        return []
    artifacts = []
    if _MD_IMAGE_RE.search(text):
        artifacts.append("image")
    if _MD_LINK_RE.search(text):
        artifacts.append("link")
    if _CODE_FENCE_RE.search(text) or _INLINE_CODE_RE.search(text):
        artifacts.append("code")
    return artifacts

def scan_folder(
    folder: Path,
    threshold: float = None,
    log_path: str = None,
    apply_remediation: bool = False
):
    all_scores = []
    over_scores = []
    removed_entries = []

    for file_path in sorted(folder.glob('*.txt')):
        try:
            text = file_path.read_text(encoding='utf-8')
        except Exception:
            continue
        markdown_artifacts = detect_markdown_artifacts(text)
        cleaned_text, intro_text, outro_text = strip_ai_wrapping(text)
        if apply_remediation and cleaned_text != text:
            try:
                normalized = cleaned_text
                if normalized and not normalized.endswith(("\n", "\r")):
                    normalized += "\n"
                file_path.write_text(normalized, encoding='utf-8')
            except Exception:
                pass
        placeholder_ratio, placeholder_count, token_count = compute_placeholder_stats(cleaned_text)
        repetition_ratio = compute_repetition_ratio(cleaned_text)
        confidence = (1.0 - min(1.0, placeholder_ratio + repetition_ratio)) * 100
        repetition_flag = repetition_ratio >= 0.2

        entry = {
            "file": file_path.name,
            "confidence": round(confidence, 2),
            "placeholder_ratio": round(placeholder_ratio, 4),
            "placeholder_count": placeholder_count,
            "token_count": token_count,
            "repetition_ratio": round(repetition_ratio, 4),
        }
        if intro_text:
            entry["remove_intro_text"] = intro_text.strip("\ufeff \t\r\n")
        if outro_text:
            entry["remove_outro_text"] = outro_text.strip("\ufeff \t\r\n")
        if repetition_flag:
            entry["repetition_detected"] = True
            entry.setdefault("notes", []).append("heavy repetition detected")
        if markdown_artifacts:
            entry["markdown_artifacts"] = markdown_artifacts

        issues = []
        if intro_text.strip():
            snippet = intro_text.strip().replace("\n", " ")
            issues.append(f'Intro chatter detected: "{snippet[:80]}{"…" if len(snippet) > 80 else ""}"')
        if outro_text.strip():
            snippet = outro_text.strip().replace("\n", " ")
            issues.append(f'Outro chatter detected: "{snippet[:80]}{"…" if len(snippet) > 80 else ""}"')
        if repetition_ratio >= 0.15:
            issues.append(f"Possible duplicated content (~{repetition_ratio * 100:.0f}% repeated)")
        if markdown_artifacts:
            if "image" in markdown_artifacts:
                issues.append("Markdown image reference detected (e.g. ![img](file))")
            if "link" in markdown_artifacts:
                issues.append("Markdown link detected ([text](url))")
            if "code" in markdown_artifacts:
                issues.append("Markdown/code formatting detected")
        if issues:
            entry["issues"] = issues

        if apply_remediation and (intro_text or outro_text or repetition_flag):
            removed_entries.append((file_path, intro_text, outro_text, repetition_flag))
        all_scores.append(entry)
        if threshold is not None and confidence <= threshold:
            over_scores.append(entry)

    if log_path and apply_remediation and removed_entries:
        try:
            with open(log_path, "a", encoding="utf-8") as log_file:
                for file_path, intro_text, outro_text, repetition_flag in removed_entries:
                    if intro_text.strip():
                        snippet = intro_text.strip().replace("\n", " ")
                        log_file.write(f"[OUT] [OK] Removed intro chatter from {file_path}: \"{snippet}\"\n")
                    if outro_text.strip():
                        snippet = outro_text.strip().replace("\n", " ")
                        log_file.write(f"[OUT] [OK] Removed outro chatter from {file_path}: \"{snippet}\"\n")
                    if repetition_flag:
                        log_file.write(f"[OUT] [WARN] Repetition detected in {file_path}\n")
                log_file.write(f"[OUT] [OK] Quality scan updated {len(removed_entries)} file(s).\n")
        except Exception as log_err:
            pass

    output = {"all": all_scores}
    if threshold is not None:
        output["over"] = over_scores

    sys.stdout.write(json.dumps(output, indent=2))

def main():
    parser = argparse.ArgumentParser(
        description='Scan transcripts, strip conversational wrappers, and report confidence (100=clean, 0=all placeholders).'
    )
    parser.add_argument(
        '--folder', '-f', required=True,
        help='Directory containing .txt transcripts to scan'
    )
    parser.add_argument(
        '--threshold', '-t', type=float,
        help='Confidence threshold to flag files at or below this value (e.g. 85)'
    )
    parser.add_argument(
        '--log', help='Optional path to append removal logs'
    )
    parser.add_argument(
        '--apply-remediation',
        action='store_true',
        help='When set, overwrite transcripts with cleaned content and log removals.'
    )
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        sys.stdout.write(json.dumps({"error": f"Folder not found: {args.folder}"}))
        sys.exit(1)

    scan_folder(folder, args.threshold, args.log, args.apply_remediation)

if __name__ == '__main__':
    main()
