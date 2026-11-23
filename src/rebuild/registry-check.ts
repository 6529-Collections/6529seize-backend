import {
  AreaManifest,
  Probe,
  RebuildStep,
  TableClass
} from '@/rebuild/manifest.types';
import { orderSteps, waitsOn } from '@/rebuild/step-order';
import { CodeTables, LiveTable } from '@/rebuild/table-discovery';
import { protectedFlagNames } from '@/rebuild/stack/child-env';

export type RegistryProblemKind =
  /** A table code or the live schema has, in no manifest. */
  | 'MISSING'
  /** A table in more than one manifest. */
  | 'DOUBLE'
  /** A manifest table that code never names and that isn't made at runtime. */
  | 'STALE'
  /** A class other than INDEX without a reason. */
  | 'NO_REASON'
  /** The live schema disagrees with the class (a retired name as a table, a view classed as a table). */
  | 'WRONG_CLASS'
  /** A step that writes outside its area's INDEX tables, reads or needs an unknown table, or repeats an id. */
  | 'BAD_STEP'
  /** Two rebuilders write one table. */
  | 'DOUBLE_WRITER'
  /** `after` names an unknown step, or steps wait on each other. */
  | 'BAD_ORDER'
  /** A probe with a repeated id, a bad path or a placeholder without values. */
  | 'BAD_PROBE'
  /** A flag that would set one of the run's own variables. */
  | 'BAD_FLAG'
  /** A checkpoint on a table that isn't INDEX, or without a column or reason. */
  | 'BAD_CHECKPOINT';

export interface RegistryProblem {
  readonly kind: RegistryProblemKind;
  readonly area?: string;
  readonly table?: string;
  readonly detail: string;
}

export interface RegistryResult {
  readonly problems: RegistryProblem[];
  /** INDEX tables no rebuilder writes yet. */
  readonly pending: { area: string; table: string }[];
  /** Table count per class. */
  readonly classes: Record<TableClass, number>;
  /** Tables marked `planned` that code doesn't name yet. */
  readonly plannedAbsent: { area: string; table: string }[];
}

export interface RegistryInput {
  readonly manifests: readonly AreaManifest[];
  readonly codeTables: CodeTables;
  /** When given, the live schema is checked against the classes too. */
  readonly liveTables?: readonly LiveTable[];
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

function owners(manifests: readonly AreaManifest[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const table of Object.keys(manifest.tables)) {
      result.set(table, [...(result.get(table) ?? []), manifest.area]);
    }
  }
  return result;
}

function tableProblems(input: RegistryInput): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const tableOwners = owners(input.manifests);
  const known = new Set([
    ...Array.from(input.codeTables.keys()),
    ...(input.liveTables ?? []).map((table) => table.name)
  ]);
  for (const table of Array.from(known).sort(byName)) {
    if (!tableOwners.has(table)) {
      problems.push({
        kind: 'MISSING',
        table,
        detail: `${table} is in no manifest`
      });
    }
  }
  for (const [table, areas] of Array.from(tableOwners).sort(([a], [b]) =>
    byName(a, b)
  )) {
    if (areas.length > 1) {
      problems.push({
        kind: 'DOUBLE',
        table,
        detail: `${table} is in ${areas.join(', ')}`
      });
    }
  }
  for (const manifest of input.manifests) {
    for (const [table, entry] of Object.entries(manifest.tables)) {
      if (!input.codeTables.has(table) && entry.origin === undefined) {
        problems.push({
          kind: 'STALE',
          area: manifest.area,
          table,
          detail: `${table} is named nowhere in code`
        });
      }
      if (entry.class !== 'INDEX' && !entry.why?.trim()) {
        problems.push({
          kind: 'NO_REASON',
          area: manifest.area,
          table,
          detail: `${table} is ${entry.class} without a reason`
        });
      }
      if (entry.checkpoint) {
        const bad = (detail: string) =>
          problems.push({
            kind: 'BAD_CHECKPOINT',
            area: manifest.area,
            table,
            detail
          });
        if (entry.class !== 'INDEX') {
          bad(
            `${table} is ${entry.class}; only an INDEX table has a checkpoint`
          );
        }
        if (!entry.checkpoint.column.trim()) {
          bad(`${table}'s checkpoint names no column`);
        }
        if (!entry.checkpoint.reason.trim()) {
          bad(`${table}'s checkpoint has no reason`);
        }
      }
    }
  }
  return problems;
}

function liveProblems(input: RegistryInput): RegistryProblem[] {
  const classOf = new Map<string, TableClass>();
  for (const manifest of input.manifests) {
    for (const [table, entry] of Object.entries(manifest.tables)) {
      classOf.set(table, entry.class);
    }
  }
  const problems: RegistryProblem[] = [];
  for (const live of input.liveTables ?? []) {
    const tableClass = classOf.get(live.name);
    if (!tableClass) continue;
    const isView = live.type === 'VIEW';
    if (tableClass === 'RETIRED') {
      problems.push({
        kind: 'WRONG_CLASS',
        table: live.name,
        detail: `${live.name} is RETIRED but the schema has it as a ${live.type}`
      });
    } else if (isView !== (tableClass === 'VIEW')) {
      problems.push({
        kind: 'WRONG_CLASS',
        table: live.name,
        detail: `${live.name} is ${tableClass} but the schema has it as a ${live.type}`
      });
    }
  }
  return problems;
}

/** Classes a step never waits for: never a base table a branch adds. */
const NEVER_NEEDED: ReadonlySet<TableClass> = new Set<TableClass>([
  'VIEW',
  'RETIRED',
  'SCHEMA'
]);

/**
 * Why a step can't wait for `table`, or null when it can: a step waits
 * only for a table a later branch adds, one marked planned or one no
 * entity in this tree creates yet.
 */
function needRefusal(
  table: string,
  input: RegistryInput
): 'unknown' | string | null {
  const entry = input.manifests
    .map((manifest) => manifest.tables[table])
    .find(Boolean);
  if (!entry) return 'unknown';
  if (NEVER_NEEDED.has(entry.class)) {
    return `a ${entry.class} table, never one a branch adds`;
  }
  if (entry.origin === 'planned') return null;
  if (input.codeTables.get(table)?.has('entity')) {
    return 'an entity in this tree creates it, so the schema always has it';
  }
  return null;
}

function stepProblems(
  manifest: AreaManifest,
  steps: readonly RebuildStep[],
  kind: 'seed' | 'rebuilder',
  allTables: ReadonlySet<string>,
  input: RegistryInput
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  for (const step of steps) {
    for (const table of step.writes) {
      const entry = manifest.tables[table];
      const ownIndex = entry?.class === 'INDEX';
      if (kind === 'rebuilder' && !ownIndex) {
        problems.push({
          kind: 'BAD_STEP',
          area: manifest.area,
          table,
          detail: `rebuilder ${step.id} writes ${table}, not an INDEX table of ${manifest.area}`
        });
      } else if (!allTables.has(table)) {
        problems.push({
          kind: 'BAD_STEP',
          area: manifest.area,
          table,
          detail: `${kind} ${step.id} writes unknown table ${table}`
        });
      }
    }
    for (const table of step.reads ?? []) {
      if (!allTables.has(table)) {
        problems.push({
          kind: 'BAD_STEP',
          area: manifest.area,
          table,
          detail: `${kind} ${step.id} reads unknown table ${table}`
        });
      }
    }
    for (const need of step.needs ?? []) {
      const refusal = needRefusal(need.table, input);
      const problem = (detail: string) =>
        problems.push({
          kind: 'BAD_STEP',
          area: manifest.area,
          table: need.table,
          detail
        });
      if (refusal === 'unknown') {
        problem(`${kind} ${step.id} needs unknown table ${need.table}`);
      } else if (refusal) {
        problem(`${kind} ${step.id} needs ${need.table}, ${refusal}`);
      }
      if (!need.reason?.trim()) {
        problem(`${kind} ${step.id} needs ${need.table} without a reason`);
      }
    }
    if (step.timeoutMinutes <= 0) {
      problems.push({
        kind: 'BAD_STEP',
        area: manifest.area,
        detail: `${kind} ${step.id} has no time limit`
      });
    }
  }
  return problems;
}

/**
 * A rebuilder that reads a table another rebuilder writes must run after
 * it, or it reads an empty table (holdings reads identity's consolidation
 * keys, for example).
 */
function readOrderProblems(
  rebuilders: readonly RebuildStep[]
): RegistryProblem[] {
  const writerOf = new Map<string, string>();
  for (const step of rebuilders) {
    for (const table of step.writes) writerOf.set(table, step.id);
  }
  const waits = waitsOn(rebuilders);
  const problems: RegistryProblem[] = [];
  for (const step of rebuilders) {
    for (const table of step.reads ?? []) {
      const writer = writerOf.get(table);
      if (
        writer &&
        writer !== step.id &&
        !(waits.get(step.id) ?? []).includes(writer)
      ) {
        problems.push({
          kind: 'BAD_ORDER',
          detail: `rebuilder ${step.id} reads ${table}, which ${writer} rebuilds; add after: ['${writer}']`
        });
      }
    }
  }
  return problems;
}

/**
 * `last` is for seeds, and a seed that waits on a last one (its `after`,
 * or the last seed's `before`) must be last too, or it would have to run
 * before the seed it waits on.
 */
function lastProblems(manifests: readonly AreaManifest[]): RegistryProblem[] {
  const seeds = manifests.flatMap((manifest) => manifest.seeds);
  const last = new Set(seeds.filter((s) => s.last).map((s) => s.id));
  return [
    ...manifests.flatMap((manifest) =>
      manifest.rebuilders
        .filter((step) => step.last)
        .map(
          (step): RegistryProblem => ({
            kind: 'BAD_STEP',
            area: manifest.area,
            detail: `rebuilder ${step.id} is marked last; only seeds run last`
          })
        )
    ),
    ...seeds
      .filter((seed) => !seed.last)
      .flatMap((seed) =>
        (seed.after ?? [])
          .filter((id) => last.has(id))
          .map(
            (id): RegistryProblem => ({
              kind: 'BAD_ORDER',
              detail: `seed ${seed.id} waits on last seed ${id}; mark it last too`
            })
          )
      ),
    ...seeds
      .filter((seed) => seed.last)
      .flatMap((seed) =>
        (seed.before ?? [])
          .filter((id) => !last.has(id) && seeds.some((s) => s.id === id))
          .map(
            (id): RegistryProblem => ({
              kind: 'BAD_ORDER',
              detail: `last seed ${seed.id} runs before seed ${id}, which isn't last; mark it last too`
            })
          )
      )
  ];
}

function orderProblems(
  label: string,
  steps: readonly RebuildStep[]
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      problems.push({
        kind: 'BAD_STEP',
        detail: `${label} id ${step.id} is used twice`
      });
    }
    seen.add(step.id);
  }
  const { unknown, cyclic } = orderSteps(steps);
  for (const id of unknown) {
    problems.push({
      kind: 'BAD_ORDER',
      detail: `a ${label} waits on unknown step ${id}`
    });
  }
  if (cyclic.length) {
    problems.push({
      kind: 'BAD_ORDER',
      detail: `${label}s wait on each other: ${cyclic.join(', ')}`
    });
  }
  return problems;
}

function probeProblems(
  manifest: AreaManifest,
  probes: readonly Probe[],
  seen: Set<string>,
  allTables: ReadonlySet<string>
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  for (const probe of probes) {
    const problem = (detail: string) =>
      problems.push({ kind: 'BAD_PROBE', area: manifest.area, detail });
    if (seen.has(probe.id)) problem(`probe id ${probe.id} is used twice`);
    seen.add(probe.id);
    if (!probe.path.startsWith('/')) {
      problem(`probe ${probe.id} path must start with /`);
    }
    for (const [, name] of Array.from(probe.path.matchAll(PLACEHOLDER))) {
      if (!probe.each?.[name]?.length) {
        problem(`probe ${probe.id} has no values for {${name}}`);
      }
    }
    if (probe.origin === 'planned' && !probe.needs?.length) {
      problem(`planned probe ${probe.id} names no tables it waits for`);
    }
    if (probe.needs?.length && probe.origin !== 'planned') {
      problem(`probe ${probe.id} names tables it waits for but isn't planned`);
    }
    for (const table of probe.needs ?? []) {
      if (!allTables.has(table)) {
        problem(`probe ${probe.id} waits for unknown table ${table}`);
      }
    }
    for (const reasoned of [
      ...(probe.ignore ?? []),
      ...(probe.unordered ?? [])
    ]) {
      if (!reasoned.reason.trim()) {
        problem(
          `probe ${probe.id} leaves out ${reasoned.path} without a reason`
        );
      }
    }
  }
  return problems;
}

function writerProblems(manifests: readonly AreaManifest[]): RegistryProblem[] {
  const writers = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const step of manifest.rebuilders) {
      for (const table of step.writes) {
        writers.set(table, [...(writers.get(table) ?? []), step.id]);
      }
    }
  }
  return Array.from(writers)
    .filter(([, ids]) => ids.length > 1)
    .map(([table, ids]) => ({
      kind: 'DOUBLE_WRITER' as const,
      table,
      detail: `${table} is written by ${ids.join(', ')}`
    }));
}

function pendingTables(
  manifests: readonly AreaManifest[]
): { area: string; table: string }[] {
  const pending: { area: string; table: string }[] = [];
  for (const manifest of manifests) {
    const written = new Set(manifest.rebuilders.flatMap((step) => step.writes));
    for (const [table, entry] of Object.entries(manifest.tables)) {
      if (entry.class === 'INDEX' && !written.has(table)) {
        pending.push({ area: manifest.area, table });
      }
    }
  }
  return pending.sort(
    (a, b) => byName(a.area, b.area) || byName(a.table, b.table)
  );
}

function classCounts(
  manifests: readonly AreaManifest[]
): Record<TableClass, number> {
  const counts: Record<TableClass, number> = {
    INDEX: 0,
    EPHEMERAL: 0,
    PROVIDER: 0,
    SCHEMA: 0,
    VIEW: 0,
    RETIRED: 0,
    EXEMPT: 0
  };
  for (const manifest of manifests) {
    for (const entry of Object.values(manifest.tables)) {
      counts[entry.class] += 1;
    }
  }
  return counts;
}

/**
 * Checks that every table code or the live schema knows sits in exactly one
 * manifest, with a reason for every kept table, and that steps and probes are
 * well formed.
 */
export function checkRegistry(input: RegistryInput): RegistryResult {
  const allTables = new Set(
    input.manifests.flatMap((manifest) => Object.keys(manifest.tables))
  );
  const seenProbes = new Set<string>();
  const problems = [
    ...tableProblems(input),
    ...liveProblems(input),
    ...input.manifests.flatMap((manifest) => [
      ...stepProblems(manifest, manifest.seeds, 'seed', allTables, input),
      ...stepProblems(
        manifest,
        manifest.rebuilders,
        'rebuilder',
        allTables,
        input
      ),
      ...probeProblems(manifest, manifest.probes, seenProbes, allTables),
      ...protectedFlagNames(manifest.flags).map(
        (name): RegistryProblem => ({
          kind: 'BAD_FLAG',
          area: manifest.area,
          detail: `flag ${name} would set one of the run's own variables`
        })
      )
    ]),
    ...orderProblems(
      'seed',
      input.manifests.flatMap((manifest) => manifest.seeds)
    ),
    ...lastProblems(input.manifests),
    ...readOrderProblems(
      input.manifests.flatMap((manifest) => manifest.rebuilders)
    ),
    ...orderProblems(
      'rebuilder',
      input.manifests.flatMap((manifest) => manifest.rebuilders)
    ),
    ...writerProblems(input.manifests)
  ];
  return {
    problems,
    pending: pendingTables(input.manifests),
    classes: classCounts(input.manifests),
    plannedAbsent: input.manifests.flatMap((manifest) =>
      Object.entries(manifest.tables)
        .filter(
          ([table, entry]) =>
            entry.origin === 'planned' && !input.codeTables.has(table)
        )
        .map(([table]) => ({ area: manifest.area, table }))
    )
  };
}
