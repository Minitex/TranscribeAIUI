import fs from 'fs';
import path from 'path';

const LEADING_STRIP = '\ufeff \t\r\n"\'“”‘’';
const TRAILING_STRIP = '\ufeff \t\r\n"\'“”‘’';
const TRAILING_PUNCT = '!?.,-';
const TOKEN_RE = /\w+/g;
const PLACEHOLDER_TOKEN_RE = /(\[(?:unsure|blank)\])/gi;
const CODE_FENCE_RE = /(```|~~~)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const MAX_PREFIX_CHARS = 200;
const MAX_SUFFIX_CHARS = 200;
const MAX_HEURISTIC_CHARS = 240;
const MAX_HEURISTIC_LINES = 3;
const CUE_SAMPLE_LIMIT = 8;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const HTML_ENTITY_PATTERNS = [
  { key: 'amp', entity: '&amp;', pattern: /&amp;/gi },
  { key: 'quot', entity: '&quot;', pattern: /&quot;/gi },
  { key: 'apos', entity: '&#39;', pattern: /&#39;/g },
  { key: 'lt', entity: '&lt;', pattern: /&lt;/gi },
  { key: 'gt', entity: '&gt;', pattern: /&gt;/gi },
  { key: 'nbsp', entity: '&nbsp;', pattern: /&nbsp;/gi }
] as const;
const NON_VOWEL_RE = /[^aeiouy]/gi;
const VOWEL_RE = /[aeiouy]/gi;

const INTRO_TRIGGERS = [
  'okay, here is the transcription of the text from the image',
  'okay, here is the transcription of the text',
  'here is the transcription of the text',
  'here is the text transcription',
  'here is the transcription',
  'here is the text from the image',
  'the transcription from the image is'
];

const OUTRO_TRIGGERS = [
  'thank you, would you like me to transcribe another image',
  'thank you, anything else you need',
  'thank you, anything else i can help with',
  'there you go, what else would you like me to do',
  'there you go, anything else you need',
  'let me know if you need anything else',
  'let me know if you need me to transcribe another one',
  'let me know if you need me to transcribe another',
  'let me know if you need me to transcribe another image',
  'please attach more files if you want me to transcribe',
  'please attach more files if you want me to transcribe another image',
  'please attach more files if you want me to continue'
];

const INTRO_LEADS = new Set(['ok', 'okay', 'sure', 'alright', 'hello', 'hi', 'hey', 'greetings', 'here', 'this', 'let', 'i', 'we']);
const OUTRO_KEYWORDS = new Set(['anything', 'else', 'another', 'need', 'more', 'help', 'assist', 'support', 'transcribe']);
const OUTRO_POLITE = new Set(['thanks', 'thank', 'appreciate', 'happy', 'glad', 'let', 'feel', 'please', 'ready']);
const NON_ASSISTANT_OUTRO_SNIPPETS = [
  'if you like this video',
  'like and subscribe',
  'please like and subscribe',
  'subscribe to the channel',
  'subscribe for more',
  'follow for more',
  'smash that like',
  'hit the like button',
  'turn on notifications',
  'ring the bell',
  'thanks for watching'
];

const AI_BOILERPLATE_SNIPPETS = [
  'as an ai language model',
  'i am an ai',
  'i am a language model',
  'here is the transcription',
  'here is the transcribed text',
  'here is your transcription',
  'please see the transcription',
  'i can help with anything else',
  'let me know if you need anything else',
  'do you want me to transcribe another',
  'would you like me to transcribe another',
  'anything else you need',
  'feel free to ask',
  'i hope this helps'
];

type EncodedEntityKey = typeof HTML_ENTITY_PATTERNS[number]['key'];
type EncodedEntityCounts = Record<EncodedEntityKey, number>;

type ScoreBreakdown = {
  placeholder_penalty: number;
  repetition_penalty: number;
  ai_penalty: number;
  rare_token_penalty: number;
  wrapper_penalty: number;
  markdown_penalty: number;
  encoded_entity_penalty: number;
  srt_timestamp_penalty: number;
  total_penalty: number;
};

type IssueCode =
  | 'blank_transcript'
  | 'intro_chatter'
  | 'outro_chatter'
  | 'repetition'
  | 'markdown_image'
  | 'markdown_link'
  | 'markdown_code'
  | 'ai_boilerplate'
  | 'rare_tokens'
  | 'encoded_html_entities'
  | 'srt_timestamp_parse'
  | 'srt_timestamp_noncanonical'
  | 'srt_timestamp_missing_hour'
  | 'srt_timestamp_range'
  | 'srt_timestamp_overlap';

type IssueDetail = {
  code: IssueCode;
  message: string;
};

type ParsedSrtResult = {
  plainText: string;
  invalidTimestampCount: number;
  invalidRangeCount: number;
  overlapCount: number;
  nonCanonicalTimestampCount: number;
  missingHourTimestampCount: number;
  invalidTimestampCues: number[];
  invalidRangeCues: number[];
  overlapCues: number[];
  nonCanonicalTimestampCues: number[];
  missingHourTimestampCues: number[];
};

type ScanEntry = {
  file: string;
  confidence: number;
  placeholder_ratio: number;
  placeholder_count: number;
  token_count: number;
  blank_transcript?: boolean;
  non_whitespace_chars?: number;
  repetition_ratio: number;
  remove_intro_text?: string;
  remove_outro_text?: string;
  repetition_detected?: boolean;
  markdown_artifacts?: string[];
  ai_boilerplate?: string[];
  rare_token_ratio?: number;
  rare_token_count?: number;
  html_amp_count?: number;
  html_entity_count?: number;
  html_entity_counts?: EncodedEntityCounts;
  srt_invalid_timestamp_count?: number;
  srt_invalid_range_count?: number;
  srt_overlap_count?: number;
  srt_noncanonical_timestamp_count?: number;
  srt_missing_hour_timestamp_count?: number;
  score_breakdown: ScoreBreakdown;
  issue_details?: IssueDetail[];
  issues?: string[];
};

export type ScanOutput = { all: ScanEntry[]; over?: ScanEntry[] };
export type ScanProgress = {
  processed: number;
  total: number;
  file: string;
  blankCount: number;
};

export type ScanQualityOptions = {
  onProgress?: (progress: ScanProgress) => void | Promise<void>;
};

function escapeForCharClass(str: string) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function trimChars(str: string, chars: string) {
  if (!str) return '';
  const re = new RegExp(`^[${escapeForCharClass(chars)}]+|[${escapeForCharClass(chars)}]+$`, 'g');
  return str.replace(re, '');
}

function trimStartChars(str: string, chars: string) {
  const re = new RegExp(`^[${escapeForCharClass(chars)}]+`, 'g');
  return str.replace(re, '');
}

function trimEndChars(str: string, chars: string) {
  const re = new RegExp(`[${escapeForCharClass(chars)}]+$`, 'g');
  return str.replace(re, '');
}

function tokenizeWithPos(text: string) {
  const res: Array<RegExpExecArray> = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TOKEN_RE);
  while ((match = re.exec(text)) !== null) {
    res.push(match);
  }
  return res;
}

function tokensFromPhrase(phrase: string) {
  return (phrase.toLowerCase().match(TOKEN_RE) || []);
}

function normalizeTokens(segment: string) {
  return segment.toLowerCase().match(TOKEN_RE) || [];
}

function countVowels(str: string) {
  return (str.match(VOWEL_RE) || []).length;
}

function detectAiBoilerplate(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const snippet of AI_BOILERPLATE_SNIPPETS) {
    if (lower.includes(snippet)) hits.add(snippet);
  }
  return [...hits];
}

function computeRareTokenStats(text: string) {
  const tokens = text.match(/[A-Za-z0-9{}\[\]<>|\\]+/g) || [];
  const total = tokens.length || 0;
  if (!total) return { ratio: 0, count: 0, samples: [] as string[] };
  const rare: string[] = [];
  for (const tok of tokens) {
    if (tok.length >= 20) {
      rare.push(tok);
      continue;
    }
    const vowels = countVowels(tok);
    if (tok.length >= 10 && vowels <= 2) {
      rare.push(tok);
      continue;
    }
    if (/[{}[\]<>|\\]/.test(tok)) {
      rare.push(tok);
      continue;
    }
  }
  const count = rare.length;
  return { ratio: count / total, count, samples: rare.slice(0, 5) };
}

function looksLikeIntro(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > MAX_HEURISTIC_CHARS) return false;
  const lower = trimmed.toLowerCase();
  const tokens = new Set(normalizeTokens(trimmed));
  if (!tokens.size) return false;
  if (['here is the transcription', "here's the transcription", 'here is your transcript', "here's your transcript", 'this is the transcription', 'this is your transcript', 'let me transcribe', 'i will transcribe', 'i can provide', 'allow me to transcribe', 'here is the text from', "here's the text from"].some(p => lower.includes(p))) {
    return true;
  }
  const hasTranscriptionWord = ['transcription', 'transcribe', 'transcribed'].some(w => lower.includes(w));
  const hasTextContext = ['text from the image', 'text from this image', 'the text from the', 'the text of the'].some(w => lower.includes(w));
  const hasColon = lower.endsWith(':');
  const hasShortColonLead =
    hasColon &&
    trimmed.length <= 60 &&
    (lower.startsWith('here is') ||
      lower.startsWith("here's") ||
      lower.startsWith('this is') ||
      lower.startsWith('your transcript') ||
      lower.startsWith('transcription') ||
      lower.startsWith('transcript'));
  if (!(hasTranscriptionWord || hasTextContext || hasShortColonLead)) return false;
  if ([...tokens].some(t => INTRO_LEADS.has(t)) || ['here is', 'this is', 'your transcript', 'let me', 'allow me', 'i will', "i'm going to", 'providing you with', 'presenting'].some(p => lower.includes(p))) {
    return true;
  }
  if (['the image is blurry', "i can't read", 'cannot read', 'unable to transcribe', "can't transcribe"].some(p => lower.includes(p))) {
    return true;
  }
  return false;
}

function looksLikeOutro(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > MAX_HEURISTIC_CHARS) return false;
  const lower = trimmed.toLowerCase();
  const tokens = new Set(normalizeTokens(trimmed));
  if (!tokens.size) return false;
  if (NON_ASSISTANT_OUTRO_SNIPPETS.some(p => lower.includes(p))) return false;
  if (['let me know if you need', 'anything else i can', 'anything else you need', 'would you like me to', 'can i help with anything else', 'need me to transcribe another', 'feel free to ask', 'happy to help further', 'here if you need more'].some(p => lower.includes(p))) {
    return true;
  }
  if (lower.includes('anything else') && ['transcribe', 'need', 'want me to', 'you would like me to', 'i can'].some(p => lower.includes(p))) {
    return true;
  }
  const hasPolite = [...tokens].some(t => OUTRO_POLITE.has(t));
  const hasKeyword = [...tokens].some(t => OUTRO_KEYWORDS.has(t));
  const hasAssistantIntent = [
    'transcribe',
    'transcription',
    'anything else',
    'let me know',
    'i can help',
    'would you like me',
    'need me to'
  ].some(p => lower.includes(p));
  if (hasPolite && hasKeyword && hasAssistantIntent) return true;
  if (segment.includes('?') && lower.includes('anything else')) return true;
  return false;
}

function gatherLinesWithOffsets(text: string) {
  const lines = text.split(/(\n|\r\n)/).reduce<string[]>((acc, part) => {
    if (!acc.length) return [part];
    const last = acc[acc.length - 1];
    if (last === '\n' || last === '\r\n') {
      acc[acc.length - 1] = last + part;
    } else {
      acc.push(part);
    }
    return acc;
  }, []);
  const offsets = [0];
  for (const ln of lines) {
    offsets.push(offsets[offsets.length - 1] + ln.length);
  }
  return { lines, offsets };
}

function detectIntroHeuristic(text: string): string {
  const { lines, offsets } = gatherLinesWithOffsets(text);
  let idx = 0;
  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (idx >= lines.length) return '';
  const segment = trimChars(lines[idx], LEADING_STRIP + TRAILING_STRIP).trim();
  if (!looksLikeIntro(segment)) return '';
  let startOffset = offsets[idx];
  let k = idx - 1;
  while (k >= 0 && !lines[k].trim()) {
    startOffset = offsets[k];
    k -= 1;
  }
  let endOffset = offsets[idx + 1];
  let j = idx + 1;
  while (j < lines.length && !lines[j].trim()) {
    endOffset = offsets[j + 1];
    j += 1;
  }
  return text.slice(startOffset, endOffset);
}

function detectOutroHeuristic(text: string): string {
  const { lines, offsets } = gatherLinesWithOffsets(text);
  let idx = lines.length - 1;
  while (idx >= 0 && !lines[idx].trim()) idx -= 1;
  if (idx < 0) return '';
  const segment = trimChars(lines[idx], LEADING_STRIP + TRAILING_STRIP).trim();
  const innerLines = lines.map(ln => ln.trim()).filter(Boolean);
  if (innerLines.length <= 1) return '';
  if (!looksLikeOutro(segment)) return '';
  let startOffset = offsets[idx];
  let k = idx - 1;
  while (k >= 0 && !lines[k].trim()) {
    startOffset = offsets[k];
    k -= 1;
  }
  let endOffset = offsets[idx + 1];
  let m = idx + 1;
  while (m < lines.length && !lines[m].trim()) {
    endOffset = offsets[m + 1];
    m += 1;
  }
  return text.slice(startOffset, endOffset);
}

function findPrefix(text: string, phrases: string[]): string {
  const tokensWithPos = tokenizeWithPos(text);
  for (const phrase of phrases) {
    const phraseTokens = tokensFromPhrase(phrase);
    if (!phraseTokens.length) continue;
    let j = 0;
    let firstIdx: number | null = null;
    let lastEnd: number | null = null;
    for (const tokenMatch of tokensWithPos) {
      if (tokenMatch.index > MAX_PREFIX_CHARS) break;
      const tokenStr = tokenMatch[0].toLowerCase();
      if (tokenStr === phraseTokens[j]) {
        if (firstIdx === null) {
          if (text.slice(0, tokenMatch.index).trimStart().trimEnd()) break;
          firstIdx = tokenMatch.index;
        }
        j += 1;
        lastEnd = tokenMatch.index + tokenMatch[0].length;
        if (j === phraseTokens.length) {
          let end = lastEnd ?? tokenMatch.index + tokenMatch[0].length;
          while (end < text.length && (LEADING_STRIP + TRAILING_PUNCT + ':;').includes(text[end])) end += 1;
          return text.slice(0, end);
        }
      }
    }
  }
  return '';
}

function findSuffix(text: string, phrases: string[]): string {
  const tokensWithPos = tokenizeWithPos(text);
  const textLen = text.length;
  for (const phrase of phrases) {
    const phraseTokens = tokensFromPhrase(phrase);
    if (!phraseTokens.length) continue;
    let j = phraseTokens.length - 1;
    let matchStart: number | null = null;
    let matchEnd: number | null = null;
    for (let idx = tokensWithPos.length - 1; idx >= 0; idx--) {
      const tokenMatch = tokensWithPos[idx];
      if (textLen - (tokenMatch.index + tokenMatch[0].length) > MAX_SUFFIX_CHARS) break;
      const tokenStr = tokenMatch[0].toLowerCase();
      if (tokenStr === phraseTokens[j]) {
        if (matchEnd === null) matchEnd = tokenMatch.index + tokenMatch[0].length;
        matchStart = tokenMatch.index;
        j -= 1;
        if (j < 0) {
          const tail = text.slice(matchEnd ?? 0);
          const tailStripped = tail.trimEnd();
          if (tailStripped) {
            if (tailStripped.includes('\n') || tailStripped.length > 120 || (tailStripped.match(TOKEN_RE) || []).length > 16) break;
          }
          let start = matchStart ?? 0;
          while (start > 0 && (LEADING_STRIP + TRAILING_PUNCT + ':;').includes(text[start - 1])) start -= 1;
          return text.slice(start).trimEnd();
        }
      }
    }
  }
  return '';
}

function stripMarkdownArtifacts(text: string): string {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(MD_IMAGE_RE, '');
  cleaned = cleaned.replace(MD_LINK_RE, (_, p1) => p1);
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  for (const marker of ['**', '__', '*', '_', '`']) {
    cleaned = cleaned.split(marker).join('');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function stripAiWrapping(text: string) {
  let introText = findPrefix(text, INTRO_TRIGGERS);
  if (!introText) introText = detectIntroHeuristic(text);

  let cleaned = text;
  if (introText.trim()) {
    cleaned = trimStartChars(cleaned.slice(introText.length), LEADING_STRIP);
  } else {
    introText = '';
  }

  let outroText = findSuffix(cleaned, OUTRO_TRIGGERS);
  if (!outroText) outroText = detectOutroHeuristic(cleaned);

  if (outroText.trim()) {
    cleaned = trimEndChars(cleaned.slice(0, cleaned.length - outroText.length), TRAILING_STRIP);
  } else {
    outroText = '';
  }

  cleaned = stripMarkdownArtifacts(cleaned);
  return { cleaned, introText, outroText };
}

function computePlaceholderStats(text: string) {
  const normalized = text.replace(PLACEHOLDER_TOKEN_RE, ' $1 ');
  const words = normalized.split(/\s+/).filter(Boolean);
  const total = words.length;
  if (!total) return { ratio: 0, count: 0, total: 0 };
  const count = words.filter(w => ['[unsure]', '[blank]'].includes(w.toLowerCase())).length;
  return { ratio: count / total, count, total };
}

function countNonWhitespaceChars(text: string): number {
  if (!text) return 0;
  return text.replace(/\s+/g, '').length;
}

function computeRepetitionRatio(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).map(ln => ln.trim().toLowerCase()).filter(Boolean);
  let lineRatio = 0;
  if (lines.length >= 4) {
    const counts = new Map<string, number>();
    lines.forEach(ln => counts.set(ln, (counts.get(ln) || 0) + 1));
    const repeated = [...counts.values()].filter(v => v > 1).reduce((a, b) => a + b - 1, 0);
    lineRatio = repeated / lines.length;
  }
  const words = (text.toLowerCase().match(TOKEN_RE) || []);
  let ngramRatio = 0;
  const window = words.length < 24 ? 4 : words.length < 60 ? 6 : 8;
  const minWordsForNgrams = Math.max(window * 3, 12);
  if (words.length >= minWordsForNgrams) {
    const ngrams = new Map<string, number>();
    for (let i = 0; i <= words.length - window; i++) {
      const key = words.slice(i, i + window).join(' ');
      ngrams.set(key, (ngrams.get(key) || 0) + 1);
    }
    const minRepeatCount = words.length < 40 ? 3 : 2;
    const repeated = [...ngrams.values()]
      .filter(v => v >= minRepeatCount)
      .reduce((a, b) => a + (b - 1), 0);
    const totalWindows = Math.max(words.length - window + 1, 1);
    ngramRatio = repeated / totalWindows;
  }
  return Math.max(0, Math.min(1, Math.max(lineRatio, ngramRatio)));
}

function detectMarkdownArtifacts(text: string) {
  if (!text) return [];
  const artifacts: string[] = [];
  MD_IMAGE_RE.lastIndex = 0;
  MD_LINK_RE.lastIndex = 0;
  CODE_FENCE_RE.lastIndex = 0;
  INLINE_CODE_RE.lastIndex = 0;
  if (MD_IMAGE_RE.test(text)) artifacts.push('image');
  if (MD_LINK_RE.test(text)) artifacts.push('link');
  if (CODE_FENCE_RE.test(text) || INLINE_CODE_RE.test(text)) artifacts.push('code');
  return artifacts;
}

function createEmptyEntityCounts(): EncodedEntityCounts {
  return {
    amp: 0,
    quot: 0,
    apos: 0,
    lt: 0,
    gt: 0,
    nbsp: 0
  };
}

function countEncodedEntities(text: string): { total: number; counts: EncodedEntityCounts } {
  const counts = createEmptyEntityCounts();
  if (!text) return { total: 0, counts };
  let total = 0;
  for (const descriptor of HTML_ENTITY_PATTERNS) {
    const matches = text.match(descriptor.pattern);
    const count = matches ? matches.length : 0;
    counts[descriptor.key] = count;
    total += count;
  }
  return { total, counts };
}

function pushCueSample(list: number[], cueNumber: number) {
  if (!Number.isFinite(cueNumber) || cueNumber <= 0) return;
  if (list.length >= CUE_SAMPLE_LIMIT) return;
  list.push(cueNumber);
}

function formatCueSample(cues: number[], total: number): string {
  if (!cues.length) return '';
  const shown = cues.map(cue => `#${cue}`).join(', ');
  const extra = total > cues.length ? ', …' : '';
  return ` Cues: ${shown}${extra}.`;
}

type ParsedSrtTimestampToken = {
  ms: number;
  normalized: string;
  nonCanonical: boolean;
  missingHour: boolean;
};

type ParsedSrtTimestampLine = {
  startMs: number;
  endMs: number;
  nonCanonical: boolean;
  missingHour: boolean;
};

function toMs(hours: number, minutes: number, seconds: number, millis: number): number {
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis;
}

function parseSrtTimestampToken(raw: string): ParsedSrtTimestampToken | null {
  const token = raw.trim();

  const full = token.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (full) {
    const hours = Number(full[1]);
    const minutes = Number(full[2]);
    const seconds = Number(full[3]);
    const millis = Number(full[4]);
    if (minutes > 59 || seconds > 59 || millis > 999) return null;
    const normalized = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    return {
      ms: toMs(hours, minutes, seconds, millis),
      normalized,
      nonCanonical: token !== normalized,
      missingHour: false
    };
  }

  const short = token.match(/^(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (short) {
    const minutes = Number(short[1]);
    const seconds = Number(short[2]);
    const millis = Number(short[3]);
    if (minutes > 59 || seconds > 59 || millis > 999) return null;
    const normalized = `00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    return {
      ms: toMs(0, minutes, seconds, millis),
      normalized,
      nonCanonical: true,
      missingHour: true
    };
  }

  return null;
}

function parseSrtTimestampLine(rawLine: string): ParsedSrtTimestampLine | null {
  const match = rawLine.match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
  if (!match) return null;
  const start = parseSrtTimestampToken(match[1]);
  const end = parseSrtTimestampToken(match[2]);
  if (!start || !end) return null;
  return {
    startMs: start.ms,
    endMs: end.ms,
    nonCanonical: start.nonCanonical || end.nonCanonical,
    missingHour: start.missingHour || end.missingHour
  };
}

function parseSrtForQuality(raw: string): ParsedSrtResult {
  const lines = raw.split(/\r?\n/);
  const cueTexts: string[] = [];
  let i = 0;
  let prevEndMs: number | null = null;
  let cueOrdinal = 0;
  let invalidTimestampCount = 0;
  let invalidRangeCount = 0;
  let overlapCount = 0;
  let nonCanonicalTimestampCount = 0;
  let missingHourTimestampCount = 0;
  const invalidTimestampCues: number[] = [];
  const invalidRangeCues: number[] = [];
  const overlapCues: number[] = [];
  const nonCanonicalTimestampCues: number[] = [];
  const missingHourTimestampCues: number[] = [];

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length) break;

    let currentLine = lines[i].trim();
    let cueNumber: number | null = null;
    if (/^\d+$/.test(currentLine) && i + 1 < lines.length) {
      cueNumber = Number(currentLine);
      i += 1;
      currentLine = lines[i].trim();
    }
    cueOrdinal += 1;
    const resolvedCueNumber = cueNumber && cueNumber > 0 ? cueNumber : cueOrdinal;

    const parsedTimestampLine = parseSrtTimestampLine(currentLine);
    if (!parsedTimestampLine) {
      invalidTimestampCount += 1;
      pushCueSample(invalidTimestampCues, resolvedCueNumber);
      while (i < lines.length && lines[i].trim()) i += 1;
      continue;
    }

    if (parsedTimestampLine.nonCanonical) {
      nonCanonicalTimestampCount += 1;
      pushCueSample(nonCanonicalTimestampCues, resolvedCueNumber);
    }
    if (parsedTimestampLine.missingHour) {
      missingHourTimestampCount += 1;
      pushCueSample(missingHourTimestampCues, resolvedCueNumber);
    }

    const startMs = parsedTimestampLine.startMs;
    const endMs = parsedTimestampLine.endMs;
    if (endMs <= startMs) {
      invalidRangeCount += 1;
      pushCueSample(invalidRangeCues, resolvedCueNumber);
    }
    if (prevEndMs !== null && startMs < prevEndMs) {
      overlapCount += 1;
      pushCueSample(overlapCues, resolvedCueNumber);
    }
    prevEndMs = endMs;

    i += 1;
    const blockText: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      blockText.push(lines[i]);
      i += 1;
    }
    const cueText = blockText.join('\n').trim();
    if (cueText) cueTexts.push(cueText);
  }

  return {
    plainText: cueTexts.join('\n'),
    invalidTimestampCount,
    invalidRangeCount,
    overlapCount,
    nonCanonicalTimestampCount,
    missingHourTimestampCount,
    invalidTimestampCues,
    invalidRangeCues,
    overlapCues,
    nonCanonicalTimestampCues,
    missingHourTimestampCues
  };
}

export async function scanQualityFolder(
  folder: string,
  threshold?: number,
  options: ScanQualityOptions = {}
): Promise<ScanOutput> {
  const dirEntries = await fs.promises.readdir(folder).catch(() => []);
  const qualityFiles = dirEntries.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ext === '.txt' || ext === '.srt';
  });
  const all: ScanEntry[] = [];
  const over: ScanEntry[] = [];
  const sortedFiles = qualityFiles.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  const totalFiles = sortedFiles.length;
  let processed = 0;
  let blankCount = 0;

  for (const name of sortedFiles) {
    const fullPath = path.join(folder, name);
    let text: string;
    try {
      text = await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      processed += 1;
      if (options.onProgress) {
        await options.onProgress({ processed, total: totalFiles, file: name, blankCount });
      }
      continue;
    }
    const sourceExt = path.extname(name).toLowerCase();
    let parsedSrt: ParsedSrtResult | null = null;
    let analyzableText = text;
    if (sourceExt === '.srt') {
      parsedSrt = parseSrtForQuality(text);
      analyzableText = parsedSrt.plainText;
    }

    const markdownArtifacts = detectMarkdownArtifacts(analyzableText);
    const { cleaned, introText, outroText } = stripAiWrapping(analyzableText);
    const placeholderStats = computePlaceholderStats(cleaned);
    const repetitionRatio = computeRepetitionRatio(cleaned);
    const aiFlags = detectAiBoilerplate(cleaned);
    const rareStats = computeRareTokenStats(cleaned);
    const entityStats = countEncodedEntities(cleaned);
    const nonWhitespaceChars = countNonWhitespaceChars(cleaned);
    const blankTranscript = nonWhitespaceChars === 0;
    const aiPenalty = aiFlags.length ? 0.05 : 0;
    const rarePenalty = Math.min(rareStats.ratio, 0.1);
    const placeholderPenalty = placeholderStats.ratio;
    const repetitionPenalty = repetitionRatio;
    const introPenalty = introText?.trim() ? 0.06 : 0;
    const outroPenalty = outroText?.trim() ? 0.04 : 0;
    const wrapperPenalty = introPenalty + outroPenalty;
    const markdownPenalty = markdownArtifacts.length ? 0.05 : 0;
    const encodedEntityPenalty = Math.min(entityStats.total * 0.01, 0.05);
    const srtTimestampPenalty = parsedSrt
      ? Math.min(
        0.2,
        parsedSrt.invalidTimestampCount * 0.04 +
          parsedSrt.invalidRangeCount * 0.04 +
          parsedSrt.overlapCount * 0.03 +
          parsedSrt.nonCanonicalTimestampCount * 0.015 +
          parsedSrt.missingHourTimestampCount * 0.01
      )
      : 0;
    const totalPenalty = Math.min(
      1,
      placeholderPenalty +
        repetitionPenalty +
        aiPenalty +
        rarePenalty +
        wrapperPenalty +
        markdownPenalty +
        encodedEntityPenalty +
        srtTimestampPenalty
    );
    const confidence = blankTranscript
      ? 0
      : (1 - totalPenalty) * 100;
    const repetitionFlag = repetitionRatio >= 0.2;

    const entry: ScanEntry = {
      file: name,
      confidence: Number(confidence.toFixed(2)),
      placeholder_ratio: Number(placeholderStats.ratio.toFixed(4)),
      placeholder_count: placeholderStats.count,
      token_count: placeholderStats.total,
      non_whitespace_chars: nonWhitespaceChars,
      repetition_ratio: Number(repetitionRatio.toFixed(4)),
      score_breakdown: {
        placeholder_penalty: Number(placeholderPenalty.toFixed(4)),
        repetition_penalty: Number(repetitionPenalty.toFixed(4)),
        ai_penalty: Number(aiPenalty.toFixed(4)),
        rare_token_penalty: Number(rarePenalty.toFixed(4)),
        wrapper_penalty: Number(wrapperPenalty.toFixed(4)),
        markdown_penalty: Number(markdownPenalty.toFixed(4)),
        encoded_entity_penalty: Number(encodedEntityPenalty.toFixed(4)),
        srt_timestamp_penalty: Number(srtTimestampPenalty.toFixed(4)),
        total_penalty: Number(totalPenalty.toFixed(4))
      }
    };
    if (blankTranscript) entry.blank_transcript = true;
    if (introText) entry.remove_intro_text = trimChars(introText, LEADING_STRIP + TRAILING_STRIP);
    if (outroText) entry.remove_outro_text = trimChars(outroText, LEADING_STRIP + TRAILING_STRIP);
    if (repetitionFlag) entry.repetition_detected = true;
    if (markdownArtifacts.length) entry.markdown_artifacts = markdownArtifacts;
    if (aiFlags.length) entry.ai_boilerplate = aiFlags;
    if (rareStats.count) {
      entry.rare_token_ratio = Number(rareStats.ratio.toFixed(4));
      entry.rare_token_count = rareStats.count;
    }
    if (entityStats.counts.amp > 0) {
      entry.html_amp_count = entityStats.counts.amp;
    }
    if (entityStats.total > 0) {
      entry.html_entity_count = entityStats.total;
      entry.html_entity_counts = entityStats.counts;
    }
    if (parsedSrt) {
      if (parsedSrt.invalidTimestampCount > 0) {
        entry.srt_invalid_timestamp_count = parsedSrt.invalidTimestampCount;
      }
      if (parsedSrt.invalidRangeCount > 0) {
        entry.srt_invalid_range_count = parsedSrt.invalidRangeCount;
      }
      if (parsedSrt.overlapCount > 0) {
        entry.srt_overlap_count = parsedSrt.overlapCount;
      }
      if (parsedSrt.nonCanonicalTimestampCount > 0) {
        entry.srt_noncanonical_timestamp_count = parsedSrt.nonCanonicalTimestampCount;
      }
      if (parsedSrt.missingHourTimestampCount > 0) {
        entry.srt_missing_hour_timestamp_count = parsedSrt.missingHourTimestampCount;
      }
    }

    const issueDetails: IssueDetail[] = [];
    const addIssue = (code: IssueCode, message: string) => {
      issueDetails.push({ code, message });
    };

    if (blankTranscript) {
      addIssue('blank_transcript', 'Transcript appears blank (no readable text found)');
    }
    if (introText?.trim()) {
      const snippet = introText.trim().replace(/\s+/g, ' ');
      addIssue(
        'intro_chatter',
        `Intro chatter detected: "${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}"`
      );
    }
    if (outroText?.trim()) {
      const snippet = outroText.trim().replace(/\s+/g, ' ');
      addIssue(
        'outro_chatter',
        `Outro chatter detected: "${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}"`
      );
    }
    if (repetitionRatio >= 0.15) {
      addIssue('repetition', `Possible duplicated content (~${Math.round(repetitionRatio * 100)}% repeated)`);
    }
    if (markdownArtifacts.length) {
      if (markdownArtifacts.includes('image')) {
        addIssue('markdown_image', 'Markdown image reference detected (e.g. ![img](file))');
      }
      if (markdownArtifacts.includes('link')) {
        addIssue('markdown_link', 'Markdown link detected ([text](url))');
      }
      if (markdownArtifacts.includes('code')) {
        addIssue('markdown_code', 'Markdown/code formatting detected');
      }
    }
    if (aiFlags.length) {
      addIssue(
        'ai_boilerplate',
        `Possible AI boilerplate detected (${aiFlags.length} phrase${aiFlags.length > 1 ? 's' : ''})`
      );
    }
    if (rareStats.ratio >= 0.05 && rareStats.count >= 3) {
      addIssue(
        'rare_tokens',
        `Unusual token density (~${Math.round(rareStats.ratio * 100)}% of words look machine-generated or malformed)`
      );
    }
    if (entityStats.total > 0) {
      const entitySummary = HTML_ENTITY_PATTERNS
        .map(def => {
          const count = entityStats.counts[def.key];
          return count > 0 ? `${def.entity} x${count}` : '';
        })
        .filter(Boolean)
        .join(', ');
      addIssue(
        'encoded_html_entities',
        `Encoded HTML entities detected (${entityStats.total} total): ${entitySummary}`
      );
    }
    if (parsedSrt?.invalidTimestampCount) {
      addIssue(
        'srt_timestamp_parse',
        `SRT timestamp parse issue (${parsedSrt.invalidTimestampCount} line${parsedSrt.invalidTimestampCount === 1 ? '' : 's'} could not be parsed as a timestamp cue).${formatCueSample(parsedSrt.invalidTimestampCues, parsedSrt.invalidTimestampCount)}`
      );
    }
    if (parsedSrt?.nonCanonicalTimestampCount) {
      addIssue(
        'srt_timestamp_noncanonical',
        `SRT timestamp formatting issue (${parsedSrt.nonCanonicalTimestampCount} cue line${parsedSrt.nonCanonicalTimestampCount === 1 ? '' : 's'} not in canonical "HH:MM:SS,mmm --> HH:MM:SS,mmm").${formatCueSample(parsedSrt.nonCanonicalTimestampCues, parsedSrt.nonCanonicalTimestampCount)}`
      );
    }
    if (parsedSrt?.missingHourTimestampCount) {
      addIssue(
        'srt_timestamp_missing_hour',
        `SRT timestamp missing-hour issue (${parsedSrt.missingHourTimestampCount} cue line${parsedSrt.missingHourTimestampCount === 1 ? '' : 's'} use "MM:SS,mmm" instead of "HH:MM:SS,mmm").${formatCueSample(parsedSrt.missingHourTimestampCues, parsedSrt.missingHourTimestampCount)}`
      );
    }
    if (parsedSrt?.invalidRangeCount) {
      addIssue(
        'srt_timestamp_range',
        `SRT timestamp range issue (${parsedSrt.invalidRangeCount} cue${parsedSrt.invalidRangeCount === 1 ? '' : 's'} with end <= start, likely wrong end time).${formatCueSample(parsedSrt.invalidRangeCues, parsedSrt.invalidRangeCount)}`
      );
    }
    if (parsedSrt?.overlapCount) {
      addIssue(
        'srt_timestamp_overlap',
        `SRT timestamp order issue (${parsedSrt.overlapCount} cue${parsedSrt.overlapCount === 1 ? '' : 's'} starts before previous cue ends).${formatCueSample(parsedSrt.overlapCues, parsedSrt.overlapCount)}`
      );
    }
    if (issueDetails.length) {
      entry.issue_details = issueDetails;
      entry.issues = issueDetails.map(issue => issue.message);
    }

    all.push(entry);
    if (blankTranscript) blankCount += 1;
    if (threshold != null && confidence <= threshold) {
      over.push(entry);
    }
    processed += 1;
    if (options.onProgress) {
      await options.onProgress({ processed, total: totalFiles, file: name, blankCount });
    }
  }

  const output: ScanOutput = { all };
  if (threshold != null) output.over = over;
  return output;
}
