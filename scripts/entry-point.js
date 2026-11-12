// The "is this file being run directly?" guard shared by the build scripts.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` is the entry point. Compares real paths,
 * so it also holds through a symlink (macOS `/var` is `/private/var`) and when
 * the script was started without its `.js` extension.
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
