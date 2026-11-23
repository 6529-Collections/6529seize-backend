import { RebuildStep } from '@/rebuild/manifest.types';

export interface OrderedSteps<T extends RebuildStep> {
  readonly order: T[];
  /** Ids named in `after` or `before` that no step has. */
  readonly unknown: string[];
  /** Step ids on a cycle; empty when the order is complete. */
  readonly cyclic: string[];
}

/**
 * The steps each step waits on: those its `after` names, and those that
 * name it in their `before`.
 */
export function waitsOn(
  steps: readonly RebuildStep[]
): Map<string, readonly string[]> {
  const waits = new Map<string, string[]>(
    steps.map((step) => [step.id, [...(step.after ?? [])]])
  );
  for (const step of steps) {
    for (const id of step.before ?? []) waits.get(id)?.push(step.id);
  }
  return waits;
}

/**
 * Orders steps so each runs after the steps it waits on (`after`, and the
 * `before` of others). Ties keep the input order, so the order is the
 * same on every run.
 */
export function orderSteps<T extends RebuildStep>(
  steps: readonly T[]
): OrderedSteps<T> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const unknown = steps.flatMap((step) =>
    [...(step.after ?? []), ...(step.before ?? [])].filter(
      (id) => !byId.has(id)
    )
  );
  const waits = waitsOn(steps);
  const done = new Set<string>();
  const order: T[] = [];
  let progressed = true;
  while (progressed && order.length < steps.length) {
    progressed = false;
    for (const step of steps) {
      const ready =
        !done.has(step.id) &&
        (waits.get(step.id) ?? []).every((id) => done.has(id) || !byId.has(id));
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

/**
 * Seeds in run order: as {@link orderSteps}, then the seeds marked `last`
 * after every other one, in the same order among themselves. A seed that
 * isn't last never waits on one that is (the registry refuses an `after`
 * onto a last seed and a last seed's `before` onto one that isn't), so
 * each seed still runs after the seeds it waits on.
 */
export function orderSeeds<T extends RebuildStep>(
  seeds: readonly T[]
): OrderedSteps<T> {
  const ordered = orderSteps(seeds);
  return {
    ...ordered,
    order: [
      ...ordered.order.filter((seed) => !seed.last),
      ...ordered.order.filter((seed) => seed.last)
    ]
  };
}
