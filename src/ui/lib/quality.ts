// Quality-scan types and the pure content-remediation helpers. Extracted
// verbatim from App.tsx; no behavior changes.

export type QualityIssueCode =
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

export type QualityIssueDetail = {
  code: QualityIssueCode;
  message: string;
};

export type QualityEntry = {
  confidence: number;
  // True when `confidence` is Mistral's own OCR confidence (averaged across
  // pages) rather than the heuristic text-quality scan score below — the two
  // use different color scales in the transcript list.
  mistralConfidence?: boolean;
  blankTranscript?: boolean;
  nonWhitespaceChars?: number;
  removeIntroText?: string;
  removeOutroText?: string;
  issueDetails?: QualityIssueDetail[];
  issues?: string[];
  placeholderCount?: number;
  placeholderRatio?: number;
  tokenCount?: number;
  repetitionRatio?: number;
  markdownArtifacts?: string[];
  htmlAmpCount?: number;
  htmlEntityCount?: number;
  htmlEntityCounts?: Record<string, number>;
  srtInvalidTimestampCount?: number;
  srtInvalidRangeCount?: number;
  srtOverlapCount?: number;
  srtNoncanonicalTimestampCount?: number;
  srtMissingHourTimestampCount?: number;
  scoreBreakdown?: ScoreBreakdown;
};

export type ScoreBreakdown = {
  placeholderPenalty: number;
  repetitionPenalty: number;
  aiPenalty: number;
  rareTokenPenalty: number;
  wrapperPenalty: number;
  markdownPenalty: number;
  encodedEntityPenalty: number;
  srtTimestampPenalty: number;
  totalPenalty: number;
};

export type ScanResultEntry = {
  file: string;
  confidence: number;
  blank_transcript?: boolean;
  non_whitespace_chars?: number;
  remove_intro_text?: string;
  remove_outro_text?: string;
  issue_details?: QualityIssueDetail[];
  issues?: string[];
  placeholder_count?: number;
  placeholder_ratio?: number;
  token_count?: number;
  repetition_ratio?: number;
  markdown_artifacts?: string[];
  html_amp_count?: number;
  html_entity_count?: number;
  html_entity_counts?: Record<string, number>;
  srt_invalid_timestamp_count?: number;
  srt_invalid_range_count?: number;
  srt_overlap_count?: number;
  srt_noncanonical_timestamp_count?: number;
  srt_missing_hour_timestamp_count?: number;
  score_breakdown?: {
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
};

export const toScoreBreakdown = (
  b: NonNullable<ScanResultEntry['score_breakdown']>
): ScoreBreakdown => ({
  placeholderPenalty: b.placeholder_penalty,
  repetitionPenalty: b.repetition_penalty,
  aiPenalty: b.ai_penalty,
  rareTokenPenalty: b.rare_token_penalty,
  wrapperPenalty: b.wrapper_penalty,
  markdownPenalty: b.markdown_penalty,
  encodedEntityPenalty: b.encoded_entity_penalty,
  srtTimestampPenalty: b.srt_timestamp_penalty,
  totalPenalty: b.total_penalty
});

export const toQualityEntry = (entry: ScanResultEntry): QualityEntry => ({
  confidence: entry.confidence,
  blankTranscript: Boolean(entry.blank_transcript),
  nonWhitespaceChars:
    typeof entry.non_whitespace_chars === 'number' ? entry.non_whitespace_chars : undefined,
  removeIntroText: entry.remove_intro_text,
  removeOutroText: entry.remove_outro_text,
  issueDetails: entry.issue_details,
  issues: entry.issues,
  placeholderCount: entry.placeholder_count,
  placeholderRatio: entry.placeholder_ratio,
  tokenCount: entry.token_count,
  repetitionRatio: entry.repetition_ratio,
  markdownArtifacts: entry.markdown_artifacts,
  htmlAmpCount: entry.html_amp_count,
  htmlEntityCount: entry.html_entity_count ?? entry.html_amp_count,
  htmlEntityCounts: entry.html_entity_counts,
  srtInvalidTimestampCount: entry.srt_invalid_timestamp_count,
  srtInvalidRangeCount: entry.srt_invalid_range_count,
  srtOverlapCount: entry.srt_overlap_count,
  srtNoncanonicalTimestampCount: entry.srt_noncanonical_timestamp_count,
  srtMissingHourTimestampCount: entry.srt_missing_hour_timestamp_count,
  scoreBreakdown: entry.score_breakdown ? toScoreBreakdown(entry.score_breakdown) : undefined
});

export type SortOption = 'name-asc' | 'name-desc' | 'confidence-desc' | 'confidence-asc';

const stripOuterQuotes = (line: string) =>
  line.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');

export const removeWrappersFromContent = (
  content: string,
  intro?: string,
  outro?: string
) => {
  if (!intro && !outro) return content;

  const endsWithNewline = /\r?\n$/.test(content);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  let startIdx = 0;
  while (startIdx < lines.length && !lines[startIdx].trim()) startIdx++;

  let workingLines = lines.slice();
  let removedIntro = false;
  let removedOutro = false;

  if (intro && startIdx < workingLines.length) {
    const firstLine = stripOuterQuotes(workingLines[startIdx]).trim();
    if (firstLine.toLowerCase().startsWith(intro.toLowerCase())) {
      workingLines = workingLines.slice(startIdx + 1);
      removedIntro = true;
    }
  }

  if (removedIntro) {
    while (workingLines.length && !workingLines[0].trim()) workingLines.shift();
  }

  if (outro && workingLines.length) {
    let endIdx = workingLines.length - 1;
    while (endIdx >= 0 && !workingLines[endIdx].trim()) endIdx--;
    if (endIdx >= 0) {
      const lastLine = stripOuterQuotes(workingLines[endIdx]).trim();
      if (lastLine.toLowerCase().startsWith(outro.toLowerCase())) {
        workingLines = workingLines.slice(0, endIdx);
        removedOutro = true;
      }
    }
  }

  if (removedOutro) {
    while (workingLines.length && !workingLines[workingLines.length - 1].trim()) {
      workingLines.pop();
    }
  }

  if (!removedIntro && !removedOutro) return content;

  const cleaned = workingLines.join(newline);
  if (!cleaned) return '';
  return endsWithNewline ? `${cleaned}${newline}` : cleaned;
};

export const stripMarkdownArtifacts = (content: string) => {
  if (!content) return '';
  const endsWithNewline = /\r?\n$/.test(content);
  let cleaned = content;
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/```([\s\S]*?)```/g, (_, inner) => {
    const trimmed = inner.trim();
    return trimmed ? `\n${trimmed}\n` : '\n';
  });
  cleaned = cleaned.replace(/~~~([\s\S]*?)~~~/g, (_, inner) => {
    const trimmed = inner.trim();
    return trimmed ? `\n${trimmed}\n` : '\n';
  });
  cleaned = cleaned.replace(/`([^`\n]+)`/g, '$1');
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  ['**', '__', '*', '_'].forEach(marker => {
    const escaped = marker.replace(/([.*+?^${}()|\[\]\\])/g, '\\$1');
    const pattern = new RegExp(`${escaped}([\\s\\S]*?)${escaped}`, 'g');
    cleaned = cleaned.replace(pattern, '$1');
  });
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  const trimmed = cleaned.trim();
  if (!trimmed) return '';
  return endsWithNewline ? `${trimmed}\n` : trimmed;
};

const HTML_ENTITY_DECODERS: Array<{
  entity: string;
  pattern: RegExp;
  replacement: string;
}> = [
  { entity: '&amp;', pattern: /&amp;/gi, replacement: '&' },
  { entity: '&quot;', pattern: /&quot;/gi, replacement: '"' },
  { entity: '&#39;', pattern: /&#39;/g, replacement: "'" },
  { entity: '&lt;', pattern: /&lt;/gi, replacement: '<' },
  { entity: '&gt;', pattern: /&gt;/gi, replacement: '>' },
  { entity: '&nbsp;', pattern: /&nbsp;/gi, replacement: ' ' }
];

export function decodeKnownHtmlEntities(content: string): {
  decoded: string;
  total: number;
  counts: Record<string, number>;
} {
  let decoded = content;
  let total = 0;
  const counts: Record<string, number> = {};
  for (const descriptor of HTML_ENTITY_DECODERS) {
    const matches = decoded.match(descriptor.pattern);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      decoded = decoded.replace(descriptor.pattern, descriptor.replacement);
      counts[descriptor.entity] = count;
      total += count;
    }
  }
  return { decoded, total, counts };
}

function formatPenaltyPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

export function buildConfidenceTitle(entry: QualityEntry, display: string): string {
  if (!entry.scoreBreakdown) {
    return `Confidence ${display}%`;
  }
  const breakdown = entry.scoreBreakdown;
  return [
    `Confidence ${display}%`,
    'Penalty breakdown:',
    `Placeholder: ${formatPenaltyPercent(breakdown.placeholderPenalty)}`,
    `Repetition: ${formatPenaltyPercent(breakdown.repetitionPenalty)}`,
    `Wrapper: ${formatPenaltyPercent(breakdown.wrapperPenalty)}`,
    `Markdown: ${formatPenaltyPercent(breakdown.markdownPenalty)}`,
    `Encoded entities: ${formatPenaltyPercent(breakdown.encodedEntityPenalty)}`,
    `AI boilerplate: ${formatPenaltyPercent(breakdown.aiPenalty)}`,
    `Rare tokens: ${formatPenaltyPercent(breakdown.rareTokenPenalty)}`,
    `SRT timestamps: ${formatPenaltyPercent(breakdown.srtTimestampPenalty)}`,
    `Total: ${formatPenaltyPercent(breakdown.totalPenalty)}`
  ].join('\n');
}

export type RemediationActions = {
  clearIntro: boolean;
  clearOutro: boolean;
  clearMarkdown: boolean;
  clearEntities: boolean;
};

export function getRemediationActions(entry: ScanResultEntry): RemediationActions {
  return {
    clearIntro: Boolean(entry.remove_intro_text),
    clearOutro: Boolean(entry.remove_outro_text),
    clearMarkdown: Boolean(entry.markdown_artifacts && entry.markdown_artifacts.length),
    clearEntities: Number(entry.html_entity_count ?? entry.html_amp_count ?? 0) > 0
  };
}

export function hasRemediationActions(actions: RemediationActions): boolean {
  return (
    actions.clearIntro ||
    actions.clearOutro ||
    actions.clearMarkdown ||
    actions.clearEntities
  );
}

export function getIssueCodesToClear(actions: RemediationActions): Set<QualityIssueCode> {
  const codes = new Set<QualityIssueCode>();
  if (actions.clearIntro) codes.add('intro_chatter');
  if (actions.clearOutro) codes.add('outro_chatter');
  if (actions.clearMarkdown) {
    codes.add('markdown_image');
    codes.add('markdown_link');
    codes.add('markdown_code');
  }
  if (actions.clearEntities) {
    codes.add('encoded_html_entities');
  }
  return codes;
}

export function isScanEntryRemediable(entry: ScanResultEntry): boolean {
  return hasRemediationActions(getRemediationActions(entry));
}
