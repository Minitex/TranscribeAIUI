import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , targetPlatform, targetArch] = process.argv;

if (!targetPlatform || !targetArch) {
  console.error('Usage: node scripts/prepare-ffmpeg-static.mjs <platform> <arch>');
  process.exit(1);
}

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), '..');
const ffmpegStaticDir = path.join(repoRoot, 'node_modules', 'ffmpeg-static');
const installScriptPath = path.join(ffmpegStaticDir, 'install.js');
const binaryName = targetPlatform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const binaryPath = path.join(ffmpegStaticDir, binaryName);

if (!fs.existsSync(ffmpegStaticDir) || !fs.existsSync(installScriptPath)) {
  console.error('ffmpeg-static is not installed. Run npm install first.');
  process.exit(1);
}

if (fs.existsSync(binaryPath)) {
  console.log(`[INFO] ffmpeg-static binary already present for ${targetPlatform}/${targetArch}: ${binaryPath}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [installScriptPath], {
  cwd: ffmpegStaticDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_platform: targetPlatform,
    npm_config_arch: targetArch
  }
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(binaryPath)) {
  console.error(`ffmpeg-static install completed but ${binaryPath} was not created.`);
  process.exit(1);
}

console.log(`[OK] Prepared ffmpeg-static binary for ${targetPlatform}/${targetArch}: ${binaryPath}`);