# AGENTS.md — TranscribeAIUI

This file tells coding agents how to work safely and effectively in this repo.

## Goals
- Keep the app working while making small, focused changes.
- Prefer readable, explicit TypeScript/React code over clever shortcuts.
- Minimize UI regressions and Electron runtime breakage.

## Project Snapshot
- Stack: Electron + Vite + React + TypeScript.
- React UI lives under `src/ui`.
- Electron main/preload lives under `src/electron`.
- Builds output to `dist-react`, `dist-electron`, and `dist`.
- Vite dev server is pinned to port `5123` and Electron dev mode expects `http://localhost:5123` (see `vite.config.ts` and `src/electron/main.ts`).

## Runtime Constraints (Important)
- The renderer currently relies on Node APIs directly via `window.require(...)` for `electron`, `fs`, `path`, and `os`.
- Electron windows are created with `nodeIntegration: true` and `contextIsolation: false` in `src/electron/main.ts`.
- Do not change those webPreferences unless you also refactor the renderer to use a preload bridge.

## Where To Work
- UI changes: `src/ui/**`
- Electron behavior / IPC: `src/electron/**`
- Shared types/utilities: search `src/**` before adding new files.

## Standard Commands
Run all commands from the repo root.

1. Install deps (already present in many environments):
```bash
npm install
```
2. Start dev mode (React + Electron together):
```bash
npm run dev
```
3. Unit tests:
```bash
npm run test:unit
```
4. E2E tests:
```bash
npm run test:e2e
```
Notes:
- `npm run test:unit` currently fails in this repo because `vitest` is not installed. Prefer `npm run build` plus a manual test plan unless the user asks to add/fix the test setup.
5. Build (TypeScript + Vite):
```bash
npm run build
```
6. Transpile Electron main/preload only:
```bash
npm run transpile:electron
```

## Change Guidelines
- Make the smallest reasonable change that solves the task.
- Do not rewrite large components unless explicitly asked.
- Preserve existing prop shapes and IPC channel names unless asked to change them.
- When changing UI, prefer incremental edits in the existing file.
- Avoid adding new dependencies unless necessary.

## TypeScript / React Conventions
- Prefer explicit types on public functions, props, and IPC payloads.
- Avoid `any`. If needed, use a narrow temporary type plus a TODO.
- Keep hooks at the top level of components.
- Derive UI from state rather than mutating DOM directly.

## Electron / IPC Safety
- Treat anything crossing IPC boundaries as untrusted input.
- Validate inputs in the Electron side (`src/electron/**`) before use.
- Do not expose new powerful preload APIs without a clear need.

## IPC Contracts To Preserve
These are relied upon by the renderer in `src/ui/App.tsx`.

- Event `transcription-progress`: emitted as `(label: string, idx: number, total: number, message: string)`. The UI mainly treats the first argument as the status label.
- Settings/state channels: `get-api-key`, `set-api-key`, `get-audio-model`, `set-audio-model`, `get-image-model`, `set-image-model`, `get-audio-prompt`, `set-audio-prompt`, `get-image-prompt`, `set-image-prompt`, `get-mistral-key`, `set-mistral-key`, `get-folder-favorites`, `set-folder-favorites`.
- Transcription/log channels: `run-transcription`, `cancel-transcription`, `read-logs`, `append-log`, `clear-logs`, `export-logs`, `clear-temp-files`.
- Files/list channels: `list-transcripts-subtitles`, `open-transcript`, `delete-transcript`, `export-transcript-list`.
- App/navigation channels: `get-app-version`, `open-settings`, `open-external`.

## Transcription Pipeline Notes
- Audio transcription (`mode === "audio"` in `run-transcription`):
  - Skips files when `${base}.txt` already exists in the output directory.
  - Converts non-mp3 inputs to mp3 via `ffmpeg-static`.
  - For audio longer than 1 hour, it splits into two parts when not in subtitle or interview mode.
  - Subtitle mode writes both `${base}.srt` and `${base}.txt` (the txt is derived from the SRT).
- Image transcription (`mode === "image"` in `run-transcription`):
  - The image prompt is read from `electron-store` in the main process; the renderer passes an empty prompt argument on purpose.
  - The UI currently requires the image input to be a folder, even though the main process can handle single files for some models.
  - Mistral OCR batch mode requires a folder input.

## Persistence Contracts (electron-store + localStorage Fallback)
Electron-side persistence keys currently include:
- `apiKey`, `mistralApiKey`
- `audioModel`, `imageModel`
- `audioPrompt`, `imagePrompt`
- `folderFavorites`

Renderer-side `localStorage` is used as a fallback. Avoid renaming these keys without updating both main and renderer code.

## Testing Expectations
- For non-trivial logic changes, run `npm run test:unit`.
- For Electron/flow changes, prefer at least a unit test or a clearly described manual test plan.
- If tests cannot run, say so and explain why.

## Manual Test Checklist (High Value)
When you change transcription, IPC, or file handling, try to cover:
- Settings open via the gear and load/save model + API keys.
- Audio flow: select input + output, transcribe, confirm logs update and output files appear, and cancellation works.
- Image flow: select folder + output, transcribe with current model, confirm logs and outputs update.
- Quality scan: run scan, confirm results populate, and remediation updates files and logs.

## Performance & UX
- Avoid blocking the UI thread with heavy synchronous work.
- Prefer progress indicators and clear error states over silent failures.

## What To Include In Responses
When an agent makes changes, it should:
- Name the key files changed.
- Summarize behavior changes in plain language.
- List the commands it ran (or could not run).
- Note any follow-up manual verification steps.

## Non-Goals / Guardrails
- Do not edit build outputs (`dist**`) by hand.
- Do not use destructive git commands (like `reset --hard`) unless explicitly requested.

## Quick Task Recipe (Suggested)
1. Read the relevant files first; don’t guess.
2. Search with `rg` before adding new helpers.
3. Make a small patch.
4. Run targeted tests or describe a manual test.
5. Report what changed and how to verify it.
