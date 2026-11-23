/**
 * The rebuild check's registry: every MySQL table belongs to exactly one area's
 * manifest, and each INDEX table is rebuilt from the allowed sources only.
 * See docs/rebuild-check.md.
 */

/** How the rebuild check treats a table or view. */
export type TableClass =
  /** Dropped, then rebuilt from the allowed sources. */
  | 'INDEX'
  /** Kept: sessions, queues, cursors, locks; recovers by itself. */
  | 'EPHEMERAL'
  /** Kept: a cache of a third-party provider. */
  | 'PROVIDER'
  /** Not data: made by the schema build. */
  | 'SCHEMA'
  /** A view the schema build makes. */
  | 'VIEW'
  /** A name code still knows, with no table in a fresh schema. */
  | 'RETIRED'
  /** Kept and reported as not covered, for the reason in its `why`. */
  | 'EXEMPT';

/** The only places a rebuilder may read from. */
export type RebuildSource =
  | 'gateway'
  | 'relays'
  | 'ethereum'
  | 'files'
  | 'repo';

export interface TableEntry {
  readonly class: TableClass;
  /** Required for every class except INDEX. */
  readonly why?: string;
  /**
   * `runtime`: made at runtime and named nowhere in code (for example by
   * TypeORM). `planned`: a later branch adds it; until that code is here
   * the check accepts the entry, and a final run fails while it is missing.
   */
  readonly origin?: 'runtime' | 'planned';
  /** Columns a table diff leaves out, each with its reason. */
  readonly volatileColumns?: readonly {
    readonly column: string;
    readonly reason: string;
  }[];
  /**
   * INDEX only: columns no step rebuilds, each with why: named clock or
   * random columns a step can't reproduce, each until a dated follow-up
   * derives it from block times. The row comparison leaves them out like
   * volatile ones, and the report lists each with its reason. A column
   * can't be both exempt and owned by a column owner.
   */
  readonly exemptColumns?: readonly {
    readonly column: string;
    readonly reason: string;
  }[];
  /**
   * INDEX only, for a table whose readers take only its one newest row by
   * `column` (a checkpoint each run writes): the row diff compares only
   * the rows holding the column's largest value (MAX, as MySQL compares
   * it), which must match in every non-volatile column, and leaves the
   * older ones out. One newest row for the whole table: a table read as
   * the newest row per key can't use it. The column must be NOT NULL.
   */
  readonly checkpoint?: {
    readonly column: string;
    readonly reason: string;
  };
}

export interface ReasonedPath {
  readonly path: string;
  readonly reason: string;
}

/** A module export called with a {@link RebuildContext}, or a command. */
export type StepRun =
  | {
      /** Repo-relative path without extension, for example `src/teamLoop/team-rebuild`. */
      readonly module: string;
      readonly exportName: string;
    }
  | { readonly command: readonly string[] };

/** A seed step or a rebuilder. */
export interface RebuildStep {
  /** Unique across all manifests, for example `identity.mirror`. */
  readonly id: string;
  readonly run: StepRun;
  /**
   * Tables the step writes. A rebuilder may write only its area's INDEX
   * tables, and may write only its partition of a table it shares.
   */
  readonly writes: readonly WrittenTable[];
  /** Tables the step reads besides those it writes. */
  readonly reads?: readonly string[];
  /** Step ids that must finish first. */
  readonly after?: readonly string[];
  /**
   * Step ids that must wait for this one: the mirror of `after`, so an
   * area can order its step ahead of another area's without editing that
   * area's manifest.
   */
  readonly before?: readonly string[];
  readonly sources: readonly RebuildSource[];
  readonly timeoutMinutes: number;
  /**
   * `planned`: a later branch adds the step's module. Until that code is
   * here, runs skip the step and note it, and a final run fails.
   */
  readonly origin?: 'planned';
  /**
   * Tables the step needs in the run's schema, each with its reason (a
   * table another branch creates). While one is missing, runs skip the
   * step as planned and name the table and the reason; a final run fails.
   */
  readonly needs?: readonly NeededTable[];
  /**
   * Seeds only: run after every seed without it, in the usual order among
   * themselves. A chain indexer uses it to catch up on blocks other seeds
   * mined after it first ran.
   */
  readonly last?: boolean;
  /**
   * Rebuilders only: rows of a table the step writes that only a later
   * change rebuilds. Seeded rows matching `where` may be missing from the
   * rebuild; each one is named in the report, and a final run fails on
   * them. A row the rebuild adds or changes still differs, whether or not
   * it matches.
   */
  readonly plannedRows?: readonly PlannedRows[];
}

export interface PlannedRows {
  readonly table: string;
  /**
   * An SQL condition on the table's columns, such as a NOT EXISTS against
   * another table, evaluated on the seeded rows only.
   */
  readonly where: string;
  readonly reason: string;
  /** The later change that rebuilds these rows. */
  readonly until: string;
}

/** A table a step writes: all of it, or a rebuilder's partition of it. */
export type WrittenTable = string | PartitionedWrite | ColumnsWrite;

/**
 * A column owner's write: only `columns` of the rows another step (the
 * table's row writer) writes. The owner runs after the row writer and may
 * only update its own columns on existing rows; the row writer may not
 * touch them.
 */
export interface ColumnsWrite {
  readonly table: string;
  readonly columns: readonly string[];
  readonly reason: string;
}

/**
 * A rebuilder's part of a table other rebuilders write too: the rows whose
 * `columns` hold one of the tuples in `values` (for example columns
 * family and type, values [['pv', 'follow']]). Every writer of such a
 * table declares a partition on the same columns, and no two share a
 * tuple.
 */
export interface PartitionedWrite {
  readonly table: string;
  readonly partition: {
    readonly columns: readonly string[];
    readonly values: readonly (readonly string[])[];
    readonly reason: string;
  };
}

/** A table a step needs in the run's schema, and why. */
export interface NeededTable {
  readonly table: string;
  readonly reason: string;
}

export type ProbeCaller = 'anonymous' | { readonly wallet: string };

export interface Probe {
  /** Unique across all manifests. */
  readonly id: string;
  readonly method?: 'GET' | 'POST';
  /** Starts with `/`. `{name}` placeholders take each value in `each[name]`. */
  readonly path: string;
  readonly body?: unknown;
  readonly each?: Readonly<Record<string, readonly string[]>>;
  readonly as?: ProbeCaller;
  /** JSONPath-like paths left out of the comparison, each with its reason. */
  readonly ignore?: readonly ReasonedPath[];
  /** Arrays compared as sets, each with its reason. */
  readonly unordered?: readonly ReasonedPath[];
  /** Defaults to any 2xx. */
  readonly expectStatus?: number;
  /**
   * `planned`: the probe reads tables a later branch creates. Runs hold it
   * while any table in `needs` is missing from the fresh schema, and say
   * so; a final run fails on a held probe.
   */
  readonly origin?: 'planned';
  /** With `origin: 'planned'`: the tables the probe waits for. */
  readonly needs?: readonly string[];
}

export interface Waiver {
  /** A route such as `GET /api/profiles/{identity}`, or a table name. */
  readonly target: string;
  readonly reason: string;
}

export interface AreaManifest {
  readonly area: string;
  /** Feature flags and settings the area's code needs for its new path. */
  readonly flags: Readonly<Record<string, string>>;
  readonly tables: Readonly<Record<string, TableEntry>>;
  readonly seeds: readonly RebuildStep[];
  readonly rebuilders: readonly RebuildStep[];
  readonly probes: readonly Probe[];
  readonly waivers?: {
    readonly routes?: readonly Waiver[];
    readonly unprobedTables?: readonly Waiver[];
    /** Rebuilt tables a final run accepts with no rows after the seeds. */
    readonly unseededTables?: readonly Waiver[];
  };
}

/** What a module step receives. Base URLs are null when the run has no such source. */
export interface RebuildContext {
  readonly area: string;
  readonly stepId: string;
  readonly sources: Readonly<Record<RebuildSource, string | null>>;
  /**
   * For seeds, with a files source: a directory the seed may write files
   * into, each listed in the directory's own files.json (id to SHA-256);
   * the files source serves them. Null for rebuilders.
   */
  readonly seedFilesDir: string | null;
  readonly mark: {
    readonly name: 'head' | 'switch';
    readonly chainHeight: number | null;
    readonly ethBlock: number | null;
  };
}

export type RebuildStepFunction = (ctx: RebuildContext) => Promise<void>;
