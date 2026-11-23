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
  /** Tables the step writes. A rebuilder may write only its area's INDEX tables. */
  readonly writes: readonly string[];
  /** Tables the step reads besides those it writes. */
  readonly reads?: readonly string[];
  /** Step ids that must finish first. */
  readonly after?: readonly string[];
  readonly sources: readonly RebuildSource[];
  readonly timeoutMinutes: number;
  /**
   * `planned`: a later branch adds the step's module. Until that code is
   * here, runs skip the step and note it, and a final run fails.
   */
  readonly origin?: 'planned';
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

/** An event as the relays serve it, with the grant it was published under. */
export interface RelayItem {
  readonly event: Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly wave: string;
  };
  readonly grant: Readonly<Record<string, unknown>>;
}

export type RelayCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The area's own check of the relay events in some waves: a module export
 * `(item: RelayItem, flags) => RelayCheckResult` that runs what the backend
 * runs on them beyond the signed-event check the harness runs on every
 * event (the grant, whose key may sign). `flags` are the area's manifest
 * flags. It runs in a child under the source guard. A replayed relay
 * recording counts for a final run only when it has events and every one
 * passes both checks.
 */
export interface RelayCheck {
  /** Wave prefixes it covers, for example `dr/`. */
  readonly waves: readonly string[];
  readonly run: { readonly module: string; readonly exportName: string };
  /** `planned`: a later branch adds the module; until then it is skipped. */
  readonly origin?: 'planned';
}

/** A role a relay grants a reader's wallet. */
export type RelayRole = 'orderer' | 'site-reader';

/** A wallet the run's relays know as a reader, with a reason. */
export interface RelayReader {
  /** `0x` and 40 lowercase hex digits. */
  readonly wallet: string;
  readonly roles?: readonly RelayRole[];
  /** The wallet's principal (`0x` and 64 hex), for its own streams. */
  readonly principal?: string;
  /** Members-only waves of drops its principal may read; needs a principal. */
  readonly memberOf?: readonly string[];
  readonly reason: string;
}

/**
 * What the run's relays let a reader see of the area's waves, as the chain
 * and the relays' operator would: a wave of drops is members-only unless
 * declared open, and a wallet has no role unless declared.
 */
export interface RelayAccess {
  /** Waves of drops anyone may read. */
  readonly openWaves?: readonly string[];
  readonly readers?: readonly RelayReader[];
}

export interface AreaManifest {
  readonly area: string;
  /** Feature flags and settings the area's code needs for its new path. */
  readonly flags: Readonly<Record<string, string>>;
  readonly tables: Readonly<Record<string, TableEntry>>;
  readonly seeds: readonly RebuildStep[];
  readonly rebuilders: readonly RebuildStep[];
  readonly probes: readonly Probe[];
  /** Checks of the area's relay events, for replayed relay recordings. */
  readonly relayChecks?: readonly RelayCheck[];
  /** Who may read the area's waves on the run's relays. */
  readonly relayAccess?: RelayAccess;
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
