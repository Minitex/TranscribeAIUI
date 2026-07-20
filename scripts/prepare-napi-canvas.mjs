import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @napi-rs/canvas ships its native binary as a separate per-platform npm
// package (an optionalDependency of @napi-rs/canvas) rather than a
// downloader script like ffmpeg-static -- npm only installs the ones that
// match the machine you ran `npm install` on. Cross-building a Windows
// package from a Mac/Linux dev machine (or any CI runner whose host OS
// differs from the target) leaves the win32 binary missing, so
// `import('@napi-rs/canvas')` throws at runtime on the built app and the PDF
// preview rasterizer silently fails ("Preview unavailable") while everything
// image-related (a different code path) still works fine.

const [, , targetPlatform, targetArch] = process.argv;

if (!targetPlatform || !targetArch) {
  console.error('Usage: node scripts/prepare-napi-canvas.mjs <platform> <arch>');
  process.exit(1);
}

// Matches the exact optionalDependencies names/version in
// node_modules/@napi-rs/canvas/package.json.
const PACKAGE_BY_TARGET = {
  'win32-x64': '@napi-rs/canvas-win32-x64-msvc',
  'win32-arm64': '@napi-rs/canvas-win32-arm64-msvc',
  'darwin-x64': '@napi-rs/canvas-darwin-x64',
  'darwin-arm64': '@napi-rs/canvas-darwin-arm64',
  'linux-x64': '@napi-rs/canvas-linux-x64-gnu',
  'linux-arm64': '@napi-rs/canvas-linux-arm64-gnu'
};

const packageName = PACKAGE_BY_TARGET[`${targetPlatform}-${targetArch}`];
if (!packageName) {
  console.error(`No known @napi-rs/canvas package for ${targetPlatform}/${targetArch}`);
  process.exit(1);
}

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), '..');
const canvasDir = path.join(repoRoot, 'node_modules', '@napi-rs', 'canvas');
const canvasPackageJsonPath = path.join(canvasDir, 'package.json');
const packageDir = path.join(repoRoot, 'node_modules', ...packageName.split('/'));

if (!fs.existsSync(canvasPackageJsonPath)) {
  console.error('@napi-rs/canvas is not installed. Run npm install first.');
  process.exit(1);
}

if (fs.existsSync(packageDir)) {
  console.log(`[INFO] ${packageName} already present: ${packageDir}`);
  process.exit(0);
}

const { version } = JSON.parse(fs.readFileSync(canvasPackageJsonPath, 'utf-8'));

// npm refuses to install a package whose declared os/cpu don't match the
// current machine (EBADPLATFORM) regardless of --os/--cpu flags -- those
// only filter which optional deps a broader install resolves, they don't
// override this specific check. --force is the documented way to bypass it
// for an intentional cross-platform install like this one.
const install = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', `${packageName}@${version}`, '--no-save', '--force'],
  { cwd: repoRoot, stdio: 'inherit' }
);

if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

if (!fs.existsSync(packageDir)) {
  console.error(`npm install completed but ${packageDir} was not created.`);
  process.exit(1);
}

console.log(`[OK] Prepared ${packageName} for ${targetPlatform}/${targetArch}: ${packageDir}`);
