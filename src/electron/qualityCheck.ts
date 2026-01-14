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
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
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

type ScanEntry = {
  file: string;
  confidence: number;
  placeholder_ratio: number;
  placeholder_count: number;
  token_count: number;
  repetition_ratio: number;
  remove_intro_text?: string;
  remove_outro_text?: string;
  repetition_detected?: boolean;
  markdown_artifacts?: string[];
  ai_boilerplate?: string[];
  rare_token_ratio?: number;
  rare_token_count?: number;
  issues?: string[];
};

export type ScanOutput = { all: ScanEntry[]; over?: ScanEntry[] };

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
  if (['let me know if you need', 'anything else i can', 'anything else you need', 'would you like me to', 'can i help with anything else', 'need me to transcribe another', 'feel free to ask', 'happy to help further', 'here if you need more'].some(p => lower.includes(p))) {
    return true;
  }
  if (lower.includes('anything else') && ['transcribe', 'need', 'want me to', 'you would like me to', 'i can'].some(p => lower.includes(p))) {
    return true;
  }
  const hasPolite = [...tokens].some(t => OUTRO_POLITE.has(t));
  const hasKeyword = [...tokens].some(t => OUTRO_KEYWORDS.has(t));
  if (hasPolite && hasKeyword) return true;
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

function computeRepetitionRatio(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).map(ln => ln.trim().toLowerCase()).filter(Boolean);
  let lineRatio = 0;
  if (lines.length) {
    const counts = new Map<string, number>();
    lines.forEach(ln => counts.set(ln, (counts.get(ln) || 0) + 1));
    const repeated = [...counts.values()].filter(v => v > 1).reduce((a, b) => a + b - 1, 0);
    lineRatio = repeated / lines.length;
  }
  const words = (text.toLowerCase().match(TOKEN_RE) || []);
  let ngramRatio = 0;
  const window = 8;
  if (words.length >= window * 2) {
    const ngrams = new Map<string, number>();
    for (let i = 0; i <= words.length - window; i++) {
      const key = words.slice(i, i + window).join(' ');
      ngrams.set(key, (ngrams.get(key) || 0) + 1);
    }
    const repeated = [...ngrams.values()].filter(v => v > 1).reduce((a, b) => a + (b - 1), 0);
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

export async function scanQualityFolder(folder: string, threshold?: number): Promise<ScanOutput> {
  const dirEntries = await fs.promises.readdir(folder).catch(() => []);
  const txtFiles = dirEntries.filter(f => f.toLowerCase().endsWith('.txt'));
  const all: ScanEntry[] = [];
  const over: ScanEntry[] = [];

  for (const name of txtFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
    const fullPath = path.join(folder, name);
    let text: string;
    try {
      text = await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }
    const markdownArtifacts = detectMarkdownArtifacts(text);
    const { cleaned, introText, outroText } = stripAiWrapping(text);
    const placeholderStats = computePlaceholderStats(cleaned);
    const repetitionRatio = computeRepetitionRatio(cleaned);
    const aiFlags = detectAiBoilerplate(cleaned);
    const rareStats = computeRareTokenStats(cleaned);
    const aiPenalty = aiFlags.length ? 0.05 : 0;
    const rarePenalty = Math.min(rareStats.ratio, 0.1);
    const confidence = (1 - Math.min(1, placeholderStats.ratio + repetitionRatio + aiPenalty + rarePenalty)) * 100;
    const repetitionFlag = repetitionRatio >= 0.2;

    const entry: ScanEntry = {
      file: name,
      confidence: Number(confidence.toFixed(2)),
      placeholder_ratio: Number(placeholderStats.ratio.toFixed(4)),
      placeholder_count: placeholderStats.count,
      token_count: placeholderStats.total,
      repetition_ratio: Number(repetitionRatio.toFixed(4))
    };
    if (introText) entry.remove_intro_text = trimChars(introText, LEADING_STRIP + TRAILING_STRIP);
    if (outroText) entry.remove_outro_text = trimChars(outroText, LEADING_STRIP + TRAILING_STRIP);
    if (repetitionFlag) entry.repetition_detected = true;
    if (markdownArtifacts.length) entry.markdown_artifacts = markdownArtifacts;
    if (aiFlags.length) entry.ai_boilerplate = aiFlags;
    if (rareStats.count) {
      entry.rare_token_ratio = Number(rareStats.ratio.toFixed(4));
      entry.rare_token_count = rareStats.count;
    }

    const issues: string[] = [];
    if (introText?.trim()) {
      const snippet = introText.trim().replace(/\s+/g, ' ');
      issues.push(`Intro chatter detected: "${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}"`);
    }
    if (outroText?.trim()) {
      const snippet = outroText.trim().replace(/\s+/g, ' ');
      issues.push(`Outro chatter detected: "${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}"`);
    }
    if (repetitionRatio >= 0.15) {
      issues.push(`Possible duplicated content (~${Math.round(repetitionRatio * 100)}% repeated)`);
    }
    if (markdownArtifacts.length) {
      if (markdownArtifacts.includes('image')) issues.push('Markdown image reference detected (e.g. ![img](file))');
      if (markdownArtifacts.includes('link')) issues.push('Markdown link detected ([text](url))');
      if (markdownArtifacts.includes('code')) issues.push('Markdown/code formatting detected');
    }
    if (aiFlags.length) {
      issues.push(`Possible AI boilerplate detected (${aiFlags.length} phrase${aiFlags.length > 1 ? 's' : ''})`);
    }
    if (rareStats.ratio >= 0.05 && rareStats.count >= 3) {
      issues.push(`Unusual token density (~${Math.round(rareStats.ratio * 100)}% of words look machine-generated or malformed)`);
    }
    if (issues.length) entry.issues = issues;

    all.push(entry);
    if (threshold != null && confidence <= threshold) {
      over.push(entry);
    }
  }

  const output: ScanOutput = { all };
  if (threshold != null) output.over = over;
  return output;
}
