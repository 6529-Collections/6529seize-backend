import { RebuildStep } from '@/rebuild/manifest.types';

/** A step a run skips as planned, and the step it needs that doesn't run. */
export interface StepSkip {
  readonly step: string;
  /** The needed step. */
  readonly needs: string;
  /**
   * `skipped`: the needed step is skipped as planned in this run (its code
   * isn't here, a table it needs is missing, or a step it needs doesn't
   * run). `outside`: it is a rebuilder outside this area run.
   */
  readonly why: 'skipped' | 'outside';
  /** The need's own reason, from the manifest. */
  readonly reason: string;
}

/**
 * The steps a run skips as planned because a step they need doesn't run
 * in it, each with the first such need. Every seed is in every run, so a
 * seed's needs fail only on a skipped seed; an area run starts only its
 * areas' rebuilders, and a rebuilder that needs another area's is skipped
 * there (its tables kept, like any skipped step's), since that area's
 * rebuilder doesn't run and its tables keep their seeded rows.
 *
 * `runsOnItsOwn(step)`: whether the step's code is here and its tables
 * are; a step that fails it is skipped for its own reason, and the steps
 * that need it with it. `inRun(id)`: whether the run would start the step
 * (every seed, and the rebuilders of the run's areas). A need on an
 * unknown step is the registry's problem, not a skip.
 */
export function stepsSkippedForSteps(
  steps: readonly RebuildStep[],
  runsOnItsOwn: (step: RebuildStep) => boolean,
  inRun: (id: string) => boolean
): Map<string, StepSkip> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const decided = new Map<string, StepSkip | null>();
  const decide = (
    step: RebuildStep,
    path: ReadonlySet<string>
  ): StepSkip | null => {
    if (decided.has(step.id)) return decided.get(step.id) ?? null;
    let skip: StepSkip | null = null;
    for (const need of step.needsSteps ?? []) {
      const needed = byId.get(need.step);
      // An unknown step, or a cycle the registry refuses: not a skip here.
      if (!needed || path.has(needed.id)) continue;
      const deeper = new Set(Array.from(path).concat(step.id));
      const why: StepSkip['why'] | null = !inRun(needed.id)
        ? 'outside'
        : !runsOnItsOwn(needed) || decide(needed, deeper) !== null
          ? 'skipped'
          : null;
      if (why) {
        skip = { step: step.id, needs: needed.id, why, reason: need.reason };
        break;
      }
    }
    decided.set(step.id, skip);
    return skip;
  };
  const skipped = new Map<string, StepSkip>();
  for (const step of steps) {
    if (!inRun(step.id) || !runsOnItsOwn(step)) continue;
    const skip = decide(step, new Set());
    if (skip) skipped.set(step.id, skip);
  }
  return skipped;
}

/** A skip the run reached, with the kind of step it skipped. */
export interface ReachedStepSkip extends StepSkip {
  readonly kind: 'seed' | 'rebuilder';
}

/**
 * Why a skipped step doesn't run, after its id: the step it needs and why,
 * as an owned column's note gives its owner's reason.
 */
export function stepSkipReason(skip: StepSkip): string {
  return `needs ${skip.needs}, ${
    skip.why === 'outside'
      ? 'outside this area run'
      : 'which is skipped as planned'
  } (${skip.reason})`;
}

/** A skip's line for the log and the report. */
export function stepSkipLine(skip: StepSkip): string {
  return `${skip.step} ${stepSkipReason(skip)}`;
}
