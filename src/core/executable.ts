import * as fs from 'fs';
import * as path from 'path';

/** Use the harness shipped with the active official extension, which shares ~/.codex's schema. */
export function bundledCodex(extensionPath?: string, platform = process.platform, arch = process.arch): string | undefined {
  if (!extensionPath) return;
  const target = platform === 'darwin' ? `macos-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    : platform === 'win32' ? `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `linux-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  const binary = path.join(extensionPath, 'bin', target, platform === 'win32' ? 'codex.exe' : 'codex');
  return fs.existsSync(binary) ? binary : undefined;
}
