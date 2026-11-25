import { RebuildContext } from '@/rebuild/manifest.types';

/** The environment variable that carries a module step's spec to its child. */
export const STEP_SPEC_ENV = 'REBUILD_STEP_SPEC';

export interface StepSpec {
  readonly repoRoot: string;
  /** Repo-relative module path without extension. */
  readonly module: string;
  readonly exportName: string;
  readonly context: RebuildContext;
}
