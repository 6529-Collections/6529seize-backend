import { RebuildStep } from '@/rebuild/manifest.types';

export interface OrderedSteps<T extends RebuildStep> {
  readonly order: T[];
  /** Ids named in `after` that no step has. */
  readonly unknown: string[];
  /** Step ids on a cycle; empty when the order is complete. */
  readonly cyclic: string[];
}

/**
 * Orders steps so each runs after the steps its `after` names. Ties keep
 * the input order, so the order is the same on every run.
 */
export function orderSteps<T extends RebuildStep>(
  steps: readonly T[]
): OrderedSteps<T> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const unknown = steps.flatMap((step) =>
    (step.after ?? []).filter((id) => !byId.has(id))
  );
  const done = new Set<string>();
  const order: T[] = [];
  let progressed = true;
  while (progressed && order.length < steps.length) {
    progressed = false;
    for (const step of steps) {
      const ready =
        !done.has(step.id) &&
        (step.after ?? []).every((id) => done.has(id) || !byId.has(id));
      if (ready) {
        done.add(step.id);
        order.push(step);
        progressed = true;
      }
    }
  }
  const cyclic = steps
    .filter((step) => !done.has(step.id))
    .map((step) => step.id);
  return { order, unknown: Array.from(new Set(unknown)), cyclic };
}
