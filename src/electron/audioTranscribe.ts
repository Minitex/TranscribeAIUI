import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { GoogleAIFileManager } from '@google/generative-ai/server';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const ffmpegPath = (ffmpegStatic as unknown as string) || '';
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg binary not found (ffmpeg-static)');

  return new Promise((resolve, reject) => {
    const proc = execFile(bin, args, { windowsHide: true }, (err) => {
      if (err) return reject(err);
      resolve();
    });
    if (signal) {
      const onAbort = () => {
        proc.kill('SIGKILL');
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const bin = ffmpegPath;
  if (!bin) return 0;
  return new Promise((resolve) => {
    const proc = execFile(bin, ['-i', filePath], { windowsHide: true }, (_err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr || '');
      if (!m) return resolve(0);
      const [h, mm, ss, ms] = m.slice(1).map(Number);
      const frac = Number(`0.${ms}`) || 0;
      resolve(h * 3600 + mm * 60 + ss + frac);
    });
    proc.on('error', () => resolve(0));
  });
}

function stripCodeFence(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:\w+)?\s*/g, '');
  out = out.replace(/\s*```$/g, '');
  return out.trim();
}

function tryParseSpeakerJson(raw: string): Array<{ speaker?: string; transcription?: string }> | null {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'object' && 'transcription' in item)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function formatSpeakerTranscript(entries: Array<{ speaker?: string; transcription?: string }>): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const speaker = entry.speaker || 'Unknown';
    const text = (entry.transcription || '').replace(/\s+/g, ' ').trim();
    lines.push(`${speaker}: ${text}`);
    lines.push('');
  }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function shiftBracketTimestamps(text: string, offsetSeconds: number): string {
  if (!offsetSeconds) return text;

  const toSeconds = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;
  const fmtTime = (total: number) => {
    total = Math.max(0, Math.round(total));
    const h = Math.floor(total / 3600);
    const rem = total % 3600;
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    return h > 0 ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` :
      `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return text.replace(/\[(\d{2}:\d{2}(?::\d{2})?)\]/g, (_m, inner) => {
    const parts = inner.split(':').map(Number);
    const [h, m, s] = parts.length === 2 ? [0, parts[0], parts[1]] : (parts as [number, number, number]);
    const newTotal = toSeconds(h, m, s) + offsetSeconds;
    return `[${fmtTime(newTotal)}]`;
  });
}

function fixSrtHours(text: string): string {
  return text.replace(
    /^(\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2},\d{3})$/gm,
    '00:$1 --> 00:$2'
  );
}

function srtToTranscript(srtText: string): string {
  const blocks = srtText.trim().split(/\n{2,}/);
  const lines: string[] = [];
  const groupSize = 5;
  for (let i = 0; i < blocks.length; i += groupSize) {
    const group = blocks.slice(i, i + groupSize);
    const header = group[0]?.split(/\r?\n/) || [];
    if (header.length < 2) continue;
    let start = header[1].split('-->')[0].trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(start)) start += ',000';
    const [h, m, sMs] = start.split(':');
    const s = sMs.split(',', 1)[0];
    const timestamp = `${Number(h).toString().padStart(2, '0')}:${Number(m).toString().padStart(2, '0')}:${Number(s).toString().padStart(2, '0')}`;
    const texts: string[] = [];
    for (const block of group) {
      const parts = block.split(/\r?\n/);
      if (parts.length < 3) continue;
      texts.push(parts.slice(2).map(p => p.trim()).join(' '));
    }
    lines.push(`[${timestamp}] ${texts.join(' ')}`);
  }
  return lines.join('\n');
}

function extractTextFromResponse(json: any): string {
  try {
    const cand = json?.candidates?.[0];
    const parts = cand?.content?.parts;
    if (Array.isArray(parts)) {
      const texts = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean);
      if (texts.length) return texts.join('\n');
    }
  } catch {}
  try {
    if (typeof json?.text === 'string') return json.text;
  } catch {}
  return '';
}

function formatPrompt(rawPrompt: string, interview: boolean, subtitles: boolean): string {
  // Prefer the prompt provided by the caller (UI) for both default and interview modes.
  let prompt = rawPrompt;
  if (subtitles) {
    prompt = `${prompt}\n\nPlease emit a valid SRT subtitle file.`;
  }
  return prompt;
}

async function uploadAndTranscribe(
  filePath: string,
  prompt: string,
  modelName: string,
  apiKey: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  const fileManager = new GoogleAIFileManager(apiKey);

  const uploadResp = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: path.basename(filePath)
  });

  // Wait for the uploaded file to be marked ACTIVE (parity with python flow)
  const uploadedName =
    uploadResp?.file?.name ||
    (uploadResp as any)?.file?.id ||
    (uploadResp as any)?.name;
  if (!uploadedName) throw new Error('Failed to upload audio file');

  let fileUri = uploadResp?.file?.uri || (uploadResp as any)?.uri;
  let fileState = (uploadResp as any)?.file?.state || (uploadResp as any)?.state;
  let attempts = 0;
  while (!fileUri || (fileState && fileState !== 'ACTIVE')) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    attempts += 1;
    if (attempts > 15) throw new Error('Timed out waiting for uploaded audio URI');
    await sleep(1000);
    const next = await fileManager.getFile(uploadedName);
    fileUri = (next as any)?.uri || (next as any)?.file?.uri;
    fileState = (next as any)?.state || (next as any)?.file?.state;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { fileData: { mimeType, fileUri } }
        ]
      }
    ]
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err: any = new Error(`Gemini audio request failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  const json = await resp.json();
  const text = extractTextFromResponse(json);
  if (!text) {
    throw new Error('Gemini returned an empty response for the audio request');
  }
  return text;
}

export function cancelAudioRequest() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

type TranscribeOptions = {
  outputDir: string;
  modelName: string;
  apiKey: string;
  rawPrompt: string;
  interviewMode: boolean;
  subtitles: boolean;
  signal?: AbortSignal;
  logger?: (msg: string) => Promise<void> | void;
};

export async function transcribeAudioGemini(filePath: string, opts: TranscribeOptions): Promise<void> {
  const {
    outputDir,
    modelName,
    apiKey,
    rawPrompt,
    interviewMode,
    subtitles,
    signal,
    logger = async () => {}
  } = opts;

  const controller = new AbortController();
  currentController = controller;
  const useSignal = (() => {
    if (!signal) return controller.signal;
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller.signal;
  })();

  await fs.promises.mkdir(outputDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const prompt = formatPrompt(rawPrompt, interviewMode, subtitles);

  let mimeType = AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
  let inputPath = filePath;
  let tmpMp3: string | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (path.extname(filePath).toLowerCase() !== '.mp3') {
      tmpMp3 = path.join(outputDir, `${base}.mp3`);
      await logger(`[INFO] Converting to mp3: ${tmpMp3}`);
      await runFfmpeg(['-y', '-i', filePath, '-codec:a', 'libmp3lame', '-qscale:a', '2', tmpMp3], useSignal);
      inputPath = tmpMp3;
      mimeType = 'audio/mpeg';
      cleanup = async () => { await fs.promises.rm(tmpMp3!).catch(() => {}); };
    }

    const totalDuration = await probeDurationSeconds(inputPath);
    await logger(`[INFO] Input duration: ${totalDuration.toFixed(2)}s`);

    if (totalDuration > 3600 && !subtitles && !interviewMode) {
      const half = totalDuration / 2;
      const part1Mp3 = path.join(outputDir, `${base}_part1.mp3`);
      const part2Mp3 = path.join(outputDir, `${base}_part2.mp3`);
      await runFfmpeg(['-y', '-i', inputPath, '-ss', '0', '-t', String(half), '-c', 'copy', part1Mp3], useSignal);
      await runFfmpeg(['-y', '-i', inputPath, '-ss', String(half), '-c', 'copy', part2Mp3], useSignal);
      await logger(`[OK] Created parts: ${part1Mp3} | ${part2Mp3}`);

      const part1Duration = await probeDurationSeconds(part1Mp3);
      await logger(`[INFO] Part1 duration (actual): ${part1Duration.toFixed(2)}s`);

      await logger(`[INFO] Uploading part1 (${path.basename(part1Mp3)})`);
      const text1 = (await uploadAndTranscribe(part1Mp3, prompt, modelName, apiKey, mimeType, useSignal)).replace('[END]', '');
      const part1Txt = path.join(outputDir, `${base}_part1.txt`);
      await fs.promises.writeFile(part1Txt, text1, 'utf-8');
      await logger(`[OK] Saved part1 TXT: ${part1Txt}`);

      await logger(`[INFO] Uploading part2 (${path.basename(part2Mp3)})`);
      const text2Raw = await uploadAndTranscribe(part2Mp3, prompt, modelName, apiKey, mimeType, useSignal);
      const text2 = shiftBracketTimestamps(text2Raw, part1Duration);
      const part2Txt = path.join(outputDir, `${base}_part2.txt`);
      await fs.promises.writeFile(part2Txt, text2, 'utf-8');
      await logger(`[OK] Saved part2 TXT: ${part2Txt}`);

      const combined = text1 + (text1.endsWith('\n') ? '' : '\n') + text2;
      const combinedTxt = path.join(outputDir, `${base}.txt`);
      await fs.promises.writeFile(combinedTxt, combined, 'utf-8');
      await logger(`[OK] Saved combined TXT: ${combinedTxt}`);

      // cleanup parts
      for (const p of [part1Mp3, part2Mp3, part1Txt, part2Txt]) {
        fs.promises.rm(p, { force: true }).catch(() => {});
      }
    } else {
      await logger(`[INFO] Uploading full audio (${path.basename(inputPath)})`);
      const rawText = await uploadAndTranscribe(inputPath, prompt, modelName, apiKey, mimeType, useSignal);

      if (subtitles) {
        const srtText = fixSrtHours(stripCodeFence(rawText || ''));
        const srtPath = path.join(outputDir, `${base}.srt`);
        await fs.promises.writeFile(srtPath, srtText, 'utf-8');
        await logger(`[OK] SRT saved: ${srtPath}`);

        const txtFromSrt = srtToTranscript(srtText);
        const txtPath = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(txtPath, txtFromSrt, 'utf-8');
        await logger(`[OK] Transcript (from SRT) saved: ${txtPath}`);
      } else if (interviewMode) {
        const entries = tryParseSpeakerJson(rawText || '');
        let outText: string;
        if (entries) {
          const pretty = formatSpeakerTranscript(entries);
          outText = pretty.endsWith('\n') ? pretty : `${pretty}\n`;
          await logger(`[OK] Interview JSON parsed: ${entries.length} entries.`);
        } else {
          outText = rawText || '';
          await logger('[WARN] Interview mode: expected JSON, saving raw text.');
        }
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, outText, 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      } else {
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, rawText || '', 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      }
    }
  } finally {
    if (cleanup) cleanup().catch(() => {});
    currentController = null;
    currentReject = null;
  }
}
