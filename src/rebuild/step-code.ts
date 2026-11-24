import * as fs from 'node:fs';
import * as path from 'node:path';
import { RebuildStep } from '@/rebuild/manifest.types';

/**
 * Whether a step's code is in the tree at `repoRoot`: false only for a
 * planned module step whose module isn't there yet.
 */
export function stepCodeIn(repoRoot: string): (step: RebuildStep) => boolean {
  return (step) => {
    if (step.origin !== 'planned' || !('module' in step.run)) return true;
    const base = path.join(repoRoot, step.run.module);
    return ['.ts', '.js'].some((ext) => fs.existsSync(`${base}${ext}`));
  };
}
