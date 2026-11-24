import {
  AreaManifest,
  Probe,
  RebuildStep,
  TableClass
} from '@/rebuild/manifest.types';
import { orderSteps, waitsOn } from '@/rebuild/step-order';
import { partitionsOf, writersOf, writtenTables } from '@/rebuild/step-writes';
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
  /**
   * Two rebuilders write one table, unless each writes its own partition
   * of it on one column.
   */
  | 'DOUBLE_WRITER'
  /** `after` or `before` names an unknown step, or steps wait on each other. */
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
  // A table an entity in this tree creates is no refusal: the branch
  // that adds it may land first, and the run notes the need as one to drop.
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
  const classOf = (table: string) =>
    input.manifests.map((m) => m.tables[table]).find(Boolean)?.class;
  for (const step of steps) {
    for (const write of step.writes) {
      const table = typeof write === 'string' ? write : write.table;
      const partition = typeof write === 'string' ? null : write.partition;
      const bad = (detail: string) =>
        problems.push({ kind: 'BAD_STEP', area: manifest.area, table, detail });
      if (partition) {
        // A partition may be of any area's INDEX table: its writers share it.
        if (kind === 'seed') {
          bad(
            `seed ${step.id} declares a partition of ${table}; only a rebuilder's write has one`
          );
        } else if (classOf(table) !== 'INDEX') {
          bad(
            `rebuilder ${step.id} writes a partition of ${table}, not an INDEX table`
          );
        }
        const { columns, values } = partition;
        if (
          !columns.length ||
          !columns.every((column) => /^[A-Za-z0-9_]+$/.test(column))
        ) {
          bad(`rebuilder ${step.id}'s partition of ${table} names no columns`);
        }
        if (!values.length) {
          bad(`rebuilder ${step.id}'s partition of ${table} has no values`);
        }
        if (values.some((tuple) => tuple.length !== columns.length)) {
          bad(
            `rebuilder ${step.id}'s partition of ${table} has a value that doesn't match its ${columns.length} columns`
          );
        }
        if (!partition.reason.trim()) {
          bad(`rebuilder ${step.id}'s partition of ${table} has no reason`);
        }
        continue;
      }
      const entry = manifest.tables[table];
      const ownIndex = entry?.class === 'INDEX';
      if (kind === 'rebuilder' && !ownIndex) {
        bad(
          `rebuilder ${step.id} writes ${table}, not an INDEX table of ${manifest.area}`
        );
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
  const writers = writersOf(rebuilders);
  const waits = waitsOn(rebuilders);
  const problems: RegistryProblem[] = [];
  for (const step of rebuilders) {
    for (const table of step.reads ?? []) {
      for (const { step: writer } of writers.get(table) ?? []) {
        if (
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
  const details = unknown.map(({ step, field, id }) =>
    field === 'after'
      ? `a ${label} waits on unknown step ${id}`
      : `${label} ${step} lists unknown step ${id} in \`before\``
  );
  for (const detail of Array.from(new Set(details))) {
    problems.push({ kind: 'BAD_ORDER', detail });
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

/** A value as an accent- and case-insensitive collation sees it. */
function foldLikeCollation(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * One rebuilder per table, unless every writer of the table declares a
 * partition on the same columns and no two partitions share a tuple.
 */
function writerProblems(manifests: readonly AreaManifest[]): RegistryProblem[] {
  const writers = writersOf(manifests.flatMap((m) => m.rebuilders));
  const problems: RegistryProblem[] = [];
  const double = (table: string, detail: string) =>
    problems.push({ kind: 'DOUBLE_WRITER', table, detail });
  for (const [table, list] of Array.from(writers)) {
    if (list.length < 2) continue;
    const ids = list.map((w) => w.step).join(', ');
    if (list.some((w) => !w.partition)) {
      double(
        table,
        `${table} is written by ${ids}; with more than one writer, each writes a partition`
      );
      continue;
    }
    const columnsOf = (w: (typeof list)[number]) =>
      w.partition!.columns.join(', ');
    if (new Set(list.map(columnsOf)).size > 1) {
      double(
        table,
        `${table}'s writers partition it on different columns: ${list
          .map((w) => `(${columnsOf(w)}) by ${w.step}`)
          .join(', ')}`
      );
      continue;
    }
    // An early warning, folded as the default collation (utf8mb4_0900_ai_ci)
    // folds: case and accents, with trailing spaces significant (NO PAD).
    // The run is the authority: before the seeds it compares every pair
    // in MySQL, under each column's own collation.
    const owner = new Map<string, string>();
    for (const writer of list) {
      for (const tuple of writer.partition!.values) {
        const key = JSON.stringify(tuple.map(foldLikeCollation));
        const other = owner.get(key);
        if (other && other !== writer.step) {
          double(
            table,
            `${table}'s partitions overlap: ${other} and ${writer.step} both write (${columnsOf(writer)}) (${tuple.map((v) => `'${v}'`).join(', ')})`
          );
        }
        owner.set(key, writer.step);
      }
    }
  }
  return problems;
}

function pendingTables(
  manifests: readonly AreaManifest[]
): { area: string; table: string }[] {
  const pending: { area: string; table: string }[] = [];
  // Any area's rebuilder may write a partition of another's table.
  const partitioned = new Set(
    manifests.flatMap((m) =>
      m.rebuilders.flatMap((step) => partitionsOf(step).map((w) => w.table))
    )
  );
  for (const manifest of manifests) {
    const written = new Set([
      ...manifest.rebuilders.flatMap(writtenTables),
      ...Array.from(partitioned)
    ]);
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
