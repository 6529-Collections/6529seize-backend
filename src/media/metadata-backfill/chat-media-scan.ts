import { forEachConcurrent } from '@/for-each-concurrent';
import { Logger } from '@/logging';
import { BackfillReport } from './backfill-report';
import { MediaObjectStore } from './backfill-storage';
import { InvalidationQueue } from './cdn-invalidation';
import {
  CandidateContext,
  CandidateDecision,
  ChatMediaSource,
  ChatMediaTarget,
  classifyDropMediaRow,
  classifyWavePictureRow
} from './chat-media-candidates';
import { ChatMediaBackfillDb } from './chat-media-backfill.db';
import { ChatMediaObjectProcessor } from './chat-media-object-processor';
import { ChatMediaVideoProcessor } from './chat-media-video-processor';
import { DecisionEntryExclusions } from './decision-entry-exclusions';
import { probeVideoLocation } from './video-location-probe';
import { formatCursor, SCAN_PHASES, ScanCursor } from './scan-cursor';

/** A systematic fault (credentials, bucket, network) stops the run early. */
export const MAX_CONSECUTIVE_FAILURES = 25;

export interface ScanOptions {
  readonly limit: number | null;
  readonly sample: number | null;
  readonly concurrency: number;
  readonly resumeAfter: ScanCursor | null;
  readonly probeVideos: boolean;
  /**
   * Chat videos are rewritten like images (and counted by --limit and
   * --sample) instead of only being counted and probed.
   */
  readonly includeVideos?: boolean;
  readonly pageSize: number;
  /** Execute runs re-read new decision entries this often. */
  readonly exclusionRefreshMillis: number;
  /**
   * When set, only these keys are processed (videos are not probed). Every
   * row is still selected and classified, so exclusions apply as usual.
   */
  readonly onlyKeys?: ReadonlySet<string> | null;
}

export interface ScanDeps {
  readonly db: ChatMediaBackfillDb;
  readonly exclusions: DecisionEntryExclusions;
  readonly processor: ChatMediaObjectProcessor;
  /** Required with `includeVideos`. */
  readonly videoProcessor?: ChatMediaVideoProcessor | null;
  readonly publicStore: MediaObjectStore;
  readonly invalidations: InvalidationQueue | null;
  readonly report: BackfillReport;
  readonly random: () => number;
  readonly now: () => number;
  /** Called after each page is fully handled, for report checkpoints. */
  readonly onPageDone?: () => void;
}

interface PageItem {
  readonly cursor: number;
  /** Classified when the page is taken, after any exclusion refresh. */
  readonly classify: () => CandidateDecision;
}

interface Page {
  readonly phase: ChatMediaSource;
  readonly items: PageItem[];
}

/**
 * Walks every candidate row (drop media, then wave pictures, then archived
 * wave pictures) in id order, classifies it against the decision-entry
 * exclusions and processes chat images (and, with `includeVideos`, chat
 * videos) with bounded concurrency. `--limit` stops after that many objects;
 * `--sample` picks a uniform random sample of them and processes only those.
 * `onlyKeys` processes only listed keys that are still selected as chat
 * media; the others are reported as not selected once the scan completes.
 */
export class ChatMediaScan {
  private readonly logger = Logger.get('CHAT_MEDIA_BACKFILL');
  private readonly seenKeys = new Set<string>();
  private readonly reservoir: ChatMediaTarget[] = [];
  private objectsSeen = 0;
  private objectsTaken = 0;
  private lastRefresh = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly deps: ScanDeps,
    private readonly options: ScanOptions
  ) {}

  private get context(): CandidateContext {
    return {
      exclusions: this.deps.exclusions.index,
      uploadKeys: this.deps.exclusions.uploadKeys
    };
  }

  async run(): Promise<boolean> {
    this.lastRefresh = this.deps.now();
    let completed = true;
    for await (const page of this.pages()) {
      await this.refreshExclusionsIfDue();
      const { targets, videos, last, stopped } = this.takePage(page);
      await this.processTargets(targets);
      await this.probeVideos(videos);
      await this.flushInvalidations();
      if (last !== null && this.options.sample === null) {
        this.deps.report.nextCursor = formatCursor({
          phase: page.phase,
          after: last
        });
      }
      this.deps.onPageDone?.();
      if (stopped) {
        completed = false;
        break;
      }
    }
    if (this.options.sample !== null) {
      await this.processTargets(this.reservoir, true);
      await this.flushInvalidations();
      return false;
    }
    if (completed) this.recordUnselectedKeys();
    return completed;
  }

  /** Requested keys that no row selected as a chat target. */
  private recordUnselectedKeys(): void {
    const filter = this.deps.report.keyFilter;
    if (!filter || !this.options.onlyKeys) return;
    this.options.onlyKeys.forEach((key) => {
      if (!this.seenKeys.has(key)) filter.notSelected.add(key);
    });
  }

  private isRequested(target: ChatMediaTarget): boolean {
    const only = this.options.onlyKeys;
    if (!only) return true;
    if (!only.has(target.key)) return false;
    if (this.deps.report.keyFilter) this.deps.report.keyFilter.processed++;
    return true;
  }

  private async refreshExclusionsIfDue(): Promise<void> {
    if (!this.deps.invalidations) return;
    if (
      this.deps.now() - this.lastRefresh <
      this.options.exclusionRefreshMillis
    ) {
      return;
    }
    await this.deps.exclusions.refresh();
    this.lastRefresh = this.deps.now();
  }

  private takePage(page: Page) {
    const targets: ChatMediaTarget[] = [];
    const videos: ChatMediaTarget[] = [];
    let last: number | null = null;
    for (const item of page.items) {
      if (this.limitReached()) return { targets, videos, last, stopped: true };
      last = item.cursor;
      const decision = item.classify();
      this.deps.report.recordRow(page.phase, decision);
      if (decision.kind !== 'target') continue;
      const { target } = decision;
      if (this.seenKeys.has(target.key)) {
        this.deps.report.selection.duplicate_rows++;
        continue;
      }
      this.seenKeys.add(target.key);
      this.deps.report.recordTarget(target);
      if (!this.isRequested(target)) continue;
      if (target.kind === 'video') this.deps.report.videos.chat_videos++;
      if (target.kind === 'video' && !this.options.includeVideos) {
        videos.push(target);
      } else {
        this.takeObject(target, targets);
      }
    }
    return { targets, videos, last, stopped: false };
  }

  private limitReached(): boolean {
    return (
      this.options.limit !== null && this.objectsTaken >= this.options.limit
    );
  }

  private takeObject(
    target: ChatMediaTarget,
    targets: ChatMediaTarget[]
  ): void {
    this.objectsSeen++;
    const sample = this.options.sample;
    if (sample === null) {
      this.objectsTaken++;
      targets.push(target);
    } else if (this.reservoir.length < sample) {
      this.reservoir.push(target);
    } else {
      const slot = Math.floor(this.deps.random() * this.objectsSeen);
      if (slot < sample) this.reservoir[slot] = target;
    }
  }

  /** Processes one object and records its outcome; returns it for samples. */
  private async processTarget(target: ChatMediaTarget) {
    const { report } = this.deps;
    if (target.kind === 'video') {
      const videoProcessor = this.deps.videoProcessor;
      if (!videoProcessor) throw new Error('No video processor configured');
      const outcome = await videoProcessor.processVideo(target);
      report.recordVideoOutcome(target, outcome);
      return outcome;
    }
    const outcome = await this.deps.processor.processImage(target);
    report.recordImageOutcome(target, outcome);
    return outcome;
  }

  private async processTargets(targets: ChatMediaTarget[], sample = false) {
    const stop = new AbortController();
    await forEachConcurrent(
      targets,
      async (target) => {
        try {
          const outcome = await this.processTarget(target);
          this.consecutiveFailures = 0;
          if (sample) this.deps.report.recordSample(target, outcome);
        } catch (error) {
          this.logger.warn(`Failed to process ${target.key}: ${String(error)}`);
          this.deps.report.recordFailure(target.key, error);
          if (sample) this.deps.report.recordSample(target, null);
          if (++this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stop.abort();
          }
        }
      },
      { concurrency: this.options.concurrency, signal: stop.signal }
    );
    if (stop.signal.aborted) {
      throw new Error(
        `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures; see the report`
      );
    }
  }

  private async probeVideos(videos: ChatMediaTarget[]): Promise<void> {
    const report = this.deps.report.videos;
    if (!this.options.probeVideos || this.options.includeVideos) return;
    await forEachConcurrent(
      videos,
      async (video) => {
        try {
          const result = await probeVideoLocation(
            this.deps.publicStore,
            video.key
          );
          if (result.kind === 'missing') {
            report.missing++;
            return;
          }
          report.probed++;
          if (result.likelyLocation) {
            report.likely_location++;
            report.likely_location_keys.add(video.key);
          }
        } catch {
          report.failed++;
        }
      },
      { concurrency: this.options.concurrency }
    );
  }

  private async flushInvalidations(): Promise<void> {
    const queue = this.deps.invalidations;
    if (!queue) return;
    await queue.flush();
    this.deps.report.invalidation.paths_submitted = queue.submitted;
    this.deps.report.invalidation.batches = queue.batches;
    this.deps.report.invalidation.pending_paths = queue.pendingCount;
  }

  private async *pages(): AsyncGenerator<Page> {
    const start = this.options.resumeAfter;
    const startIndex = start ? SCAN_PHASES.indexOf(start.phase) : 0;
    for (let index = startIndex; index < SCAN_PHASES.length; index++) {
      const phase = SCAN_PHASES[index];
      let after = start && index === startIndex ? start.after : 0;
      for (;;) {
        const items = await this.fetchPage(phase, after);
        if (!items.length) break;
        after = items[items.length - 1].cursor;
        yield { phase, items };
      }
    }
  }

  private async fetchPage(
    phase: ChatMediaSource,
    after: number
  ): Promise<PageItem[]> {
    const { db } = this.deps;
    const size = this.options.pageSize;
    if (phase === ChatMediaSource.DROP_MEDIA) {
      const rows = await db.findDropMediaCandidatesAfter(after, size);
      return rows.map((row) => ({
        cursor: Number(row.id),
        classify: () => classifyDropMediaRow(row, this.context)
      }));
    }
    const rows =
      phase === ChatMediaSource.WAVE_PICTURE
        ? await db.findWavePicturesAfter(after, size)
        : await db.findArchivedWavePicturesAfter(after, size);
    return rows.map((row) => ({
      cursor: Number(row.page_cursor),
      classify: () => classifyWavePictureRow(row, phase, this.context)
    }));
  }
}
