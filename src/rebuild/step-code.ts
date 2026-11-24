import * as fs from 'node:fs';
import * as path from 'node:path';
import { RebuildStep } from '@/rebuild/manifest.types';

/**
 * Why a step's module path can't be a repo-relative path without an
 * extension (`src/teamLoop/team-rebuild`), or null when it can.
 */
export function modulePathProblem(module: string): string | null {
  if (path.isAbsolute(module) || /^[A-Za-z]:/.test(module)) {
    return 'is absolute';
  }
  if (module.includes('\\')) return 'has a backslash; parts are split by /';
  const parts = module.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) {
    return 'leaves the repo or has an empty part';
  }
  // Windows drops a trailing dot or space and reads a colon as a stream:
  // such a part names another file there than on Linux.
  if (parts.some((part) => /[. ]$/.test(part) || part.includes(':'))) {
    return 'has a part ending in a dot or a space, or with a colon';
  }
  // A module may have dots of its own (mint-log-rebuild.seed).
  if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(module)) {
    return 'carries an extension';
  }
  return null;
}

/**
 * Whether `relative` names a file under `root`, each part spelled as the
 * directory lists it: a case-insensitive file system would find
 * `Team-Rebuild.ts` for `team-rebuild.ts`, and a Linux one would not.
 */
function fileExactlyAt(root: string, relative: string): boolean {
  let at = root;
  for (const part of relative.split('/')) {
    let names: string[];
    try {
      names = fs.readdirSync(at);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    at = path.join(at, part);
    // A link or junction leads out of the tree, or to a copy of it
    // (node_modules): its module is not this tree's code.
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  try {
    return fs.statSync(at).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a step's code is in the tree at `repoRoot`: false only for a
 * planned module step whose module file isn't there yet (a .ts or .js
 * file, spelled as the module path spells it).
 */
export function stepCodeIn(repoRoot: string): (step: RebuildStep) => boolean {
  return (step) => {
    if (step.origin !== 'planned' || !('module' in step.run)) return true;
    const { module } = step.run;
    if (modulePathProblem(module)) return false;
    return ['.ts', '.js'].some((ext) =>
      fileExactlyAt(repoRoot, `${module}${ext}`)
    );
  };
}
