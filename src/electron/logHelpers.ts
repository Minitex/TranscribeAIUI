// src/electron/logHelpers.ts
import { app } from 'electron';
import path from 'path';

export function getLogPath(mode: string): string {
  return path.join(app.getPath('userData'), `transcribe-${mode}.log`);
}