import { CandidateDecision, ChatMediaTarget } from './chat-media-candidates';
import { ImageOutcome } from './chat-media-object-processor';
import { VideoOutcome } from './chat-media-video-processor';
import { ExclusionStats } from './decision-entry-exclusions';
import { isAmbiguityReason, SkipReason } from './media-exclusion-index';

/** Each key list stops growing here; the counts stay exact. */
export const REPORT_KEY_LIST_LIMIT = 10_000;

type Counts = Record<string, number>;

/** A bounded list of object keys; values and coordinates never enter it. */
export class KeyList {
  readonly keys: string[] = [];
  truncated = 0;

  add(key: string): void {
    if (this.keys.length < REPORT_KEY_LIST_LIMIT) this.keys.push(key);
    else this.truncated++;
  }

  toJSON() {
    return this.truncated
      ? { keys: this.keys, truncated: this.truncated }
      : { keys: this.keys };
  }
}

class KeyedCounts {
  readonly counts: Counts = {};
  readonly keys: Record<string, KeyList> = {};

  add(reason: string, key?: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    if (key === undefined) return;
    this.keys[reason] ??= new KeyList();
    this.keys[reason].add(key);
  }
}

function increment(counts: Counts, name: string, by = 1): void {
  counts[name] = (counts[name] ?? 0) + by;
}

/** A scan limited to keys an earlier report skipped. */
export class KeyFilterReport {
  readonly notSelected = new KeyList();
  processed = 0;

  constructor(
    readonly sourceReport: string,
    readonly reasons: readonly string[],
    readonly requested: number,
    /** Keys the source report left out because its lists were full. */
    readonly truncatedInSource: Readonly<Record<string, number>>
  ) {}

  toJSON() {
    return {
      source_report: this.sourceReport,
      skip_reasons: this.reasons,
      requested: this.requested,
      processed: this.processed,
      not_selected: this.notSelected.keys.length + this.notSelected.truncated,
      truncated_in_source: this.truncatedInSource
    };
  }
}

export interface SampleEntry {
  readonly key: string;
  readonly source: string;
  readonly outcome: string;
  /** Image metadata categories, or video findings. */
  readonly categories: string[];
}

/**
 * The JSON report of one run: counts, object keys and reasons only. It never
 * records metadata values, coordinates, names or dates from the files.
 */
export class BackfillReport {
  readonly startedAt: string;
  finishedAt: string | null = null;
  nextCursor: string | null = null;
  completed = false;
  publicBucket: { name: string; versioning: string } | null = null;
  safetyCopyPrefix: string | null = null;
  exclusionStats: ExclusionStats | null = null;
  readonly selection = {
    rows: {} as Counts,
    chat_targets: {} as Counts,
    chat_in_direct_messages: 0,
    chat_in_replies: 0,
    duplicate_rows: 0,
    out_of_scope: {} as Counts
  };
  readonly excluded = new KeyedCounts();
  readonly ambiguous = new KeyedCounts();
  readonly categories: Counts = {};
  readonly objects = {
    inspected: 0,
    unchanged: {} as Counts,
    to_rewrite: 0,
    rewritten: 0,
    failed: 0,
    /** HDR gain map images kept by the rewrites. */
    gain_maps_kept: 0
  };
  readonly skipped = new KeyedCounts();
  /** Keys whose extension names another container, by `<ext>-><container>`. */
  readonly extensionMismatch = new KeyedCounts();
  /** Set when the scan only processes keys listed in an earlier report. */
  keyFilter: KeyFilterReport | null = null;
  readonly failedKeys: { key: string; error: string }[] = [];
  readonly rewrittenKeys = new KeyList();
  readonly toRewriteKeys = new KeyList();
  readonly bytes = {
    downloaded: 0,
    to_rewrite_original: 0,
    to_rewrite_stripped: 0
  };
  readonly videos = {
    chat_videos: 0,
    probed: 0,
    likely_location: 0,
    missing: 0,
    failed: 0,
    likely_location_keys: new KeyList(),
    /**
     * With --include-videos: video outcomes. They are also counted in
     * `objects`, `bytes` and the key lists, next to images.
     */
    inspected: 0,
    unchanged: 0,
    to_rewrite: 0,
    rewritten: 0,
    skipped: {} as Counts,
    unsupported_structures: {} as Counts,
    findings: {} as Counts
  };
  readonly invalidation = { paths_submitted: 0, batches: 0, pending_paths: 0 };
  readonly samples: SampleEntry[] = [];

  constructor(
    readonly runId: string,
    readonly command: string,
    readonly mode: 'dry-run' | 'execute',
    readonly environment: string,
    readonly options: Record<string, unknown>,
    now: Date
  ) {
    this.startedAt = now.toISOString();
  }

  recordRow(source: string, decision: CandidateDecision): void {
    increment(this.selection.rows, source);
    if (decision.kind === 'out_of_scope') {
      increment(this.selection.out_of_scope, decision.reason);
    } else if (decision.kind === 'skipped') {
      this.recordSkippedCandidate(decision.key, decision.reasons);
    }
  }

  private recordSkippedCandidate(key: string, reasons: string[]): void {
    const ambiguous = reasons.filter((reason) =>
      isAmbiguityReason(reason as SkipReason)
    );
    const exclusions = reasons.filter((reason) => !ambiguous.includes(reason));
    // Exclusion wins: a decision-entry key is excluded even if also ambiguous.
    if (exclusions.length) {
      exclusions.forEach((reason) => this.excluded.add(reason, key));
    } else {
      ambiguous.forEach((reason) => this.ambiguous.add(reason, key));
    }
  }

  recordTarget(target: ChatMediaTarget): void {
    increment(this.selection.chat_targets, target.kind);
    if (target.inDirectMessage) this.selection.chat_in_direct_messages++;
    if (target.isReply) this.selection.chat_in_replies++;
  }

  recordImageOutcome(target: ChatMediaTarget, outcome: ImageOutcome): void {
    this.objects.inspected++;
    if (outcome.extensionMismatch) {
      const { extension, container } = outcome.extensionMismatch;
      this.extensionMismatch.add(`${extension}->${container}`, target.key);
    }
    if (outcome.kind === 'clean') {
      increment(this.objects.unchanged, outcome.state);
      increment(this.categories, outcome.state);
      this.bytes.downloaded += outcome.size;
      return;
    }
    outcome.categories.forEach((category) =>
      increment(this.categories, category)
    );
    if (outcome.kind === 'skipped') {
      this.skipped.add(outcome.reason, target.key);
      this.bytes.downloaded += outcome.size;
      return;
    }
    this.bytes.downloaded += outcome.originalSize;
    this.objects.to_rewrite++;
    this.objects.gain_maps_kept += outcome.gainMapsKept;
    this.toRewriteKeys.add(target.key);
    this.bytes.to_rewrite_original += outcome.originalSize;
    this.bytes.to_rewrite_stripped += outcome.strippedSize;
    if (outcome.written) {
      this.objects.rewritten++;
      this.rewrittenKeys.add(target.key);
    }
  }

  recordVideoOutcome(target: ChatMediaTarget, outcome: VideoOutcome): void {
    this.objects.inspected++;
    this.videos.inspected++;
    if (outcome.kind === 'clean') {
      this.videos.unchanged++;
      increment(this.objects.unchanged, 'video_no_metadata');
      this.bytes.downloaded += outcome.size;
      return;
    }
    outcome.findings.forEach((finding) =>
      increment(this.videos.findings, finding)
    );
    if (outcome.kind === 'skipped') {
      this.skipped.add(outcome.reason, target.key);
      increment(this.videos.skipped, outcome.reason);
      if (outcome.problem) {
        increment(this.videos.unsupported_structures, outcome.problem);
      }
      this.bytes.downloaded += outcome.size;
      return;
    }
    this.bytes.downloaded += outcome.originalSize;
    this.objects.to_rewrite++;
    this.videos.to_rewrite++;
    this.toRewriteKeys.add(target.key);
    this.bytes.to_rewrite_original += outcome.originalSize;
    this.bytes.to_rewrite_stripped += outcome.strippedSize;
    if (outcome.written) {
      this.objects.rewritten++;
      this.videos.rewritten++;
      this.rewrittenKeys.add(target.key);
    }
  }

  recordFailure(key: string, error: unknown): void {
    this.objects.failed++;
    if (this.failedKeys.length < REPORT_KEY_LIST_LIMIT) {
      this.failedKeys.push({ key, error: describeError(error) });
    }
  }

  recordSample(
    target: ChatMediaTarget,
    outcome: ImageOutcome | VideoOutcome | null
  ): void {
    let outcomeName = 'failed';
    let categories: string[] = [];
    if (outcome?.kind === 'clean') {
      outcomeName = 'state' in outcome ? outcome.state : 'video_no_metadata';
    } else if (outcome?.kind === 'skipped') {
      outcomeName = outcome.reason;
      categories = sampleCategories(outcome);
    } else if (outcome) {
      outcomeName = outcome.written ? 'rewritten' : 'would_rewrite';
      categories = sampleCategories(outcome);
    }
    this.samples.push({
      key: target.key,
      source: target.source,
      outcome: outcomeName,
      categories
    });
  }

  finish(now: Date, completed: boolean): void {
    this.finishedAt = now.toISOString();
    this.completed = completed;
    if (completed) this.nextCursor = null;
  }

  toJSON() {
    return {
      run_id: this.runId,
      command: this.command,
      mode: this.mode,
      environment: this.environment,
      options: this.options,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      completed: this.completed,
      next_cursor: this.nextCursor,
      public_bucket: this.publicBucket,
      safety_copy_prefix: this.safetyCopyPrefix,
      exclusion_index: this.exclusionStats,
      selection: {
        ...this.selection,
        excluded: this.excluded.counts,
        ambiguous: this.ambiguous.counts
      },
      categories: this.categories,
      objects: {
        ...this.objects,
        skipped: this.skipped.counts,
        extension_mismatch: this.extensionMismatch.counts
      },
      key_filter: this.keyFilter,
      bytes: this.bytes,
      videos: this.videos,
      invalidation: this.invalidation,
      keys: {
        excluded: this.excluded.keys,
        ambiguous: this.ambiguous.keys,
        skipped: this.skipped.keys,
        extension_mismatch: this.extensionMismatch.keys,
        not_selected: this.keyFilter?.notSelected ?? null,
        failed: this.failedKeys,
        to_rewrite: this.toRewriteKeys,
        rewritten: this.rewrittenKeys
      },
      samples: this.samples
    };
  }
}

/** Image categories or video findings of a non-clean outcome. */
function sampleCategories(
  outcome: Exclude<ImageOutcome | VideoOutcome, { kind: 'clean' }>
): string[] {
  return 'findings' in outcome ? outcome.findings : outcome.categories;
}

/** Error class and a short message; storage and parser errors carry no metadata values. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 300);
  }
  return String(error).slice(0, 300);
}
