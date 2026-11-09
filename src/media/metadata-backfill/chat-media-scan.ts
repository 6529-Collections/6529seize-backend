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
import { DecisionEntryExclusions } from './decision-entry-exclusions';
import { probeVideoLocation } from './video-location-probe';
import { formatCursor, SCAN_PHASES, ScanCursor } from './scan-cursor';

export interface ScanOptions {
  readonly limit: number | null;
  readonly sample: number | null;
  readonly concurrency: number;
  readonly resumeAfter: ScanCursor | null;
  readonly probeVideos: boolean;
  readonly pageSize: number;
  /** Execute runs re-read new decision entries this often. */
  readonly exclusionRefreshMillis: number;
}

export interface ScanDeps {
  readonly db: ChatMediaBackfillDb;
  readonly exclusions: DecisionEntryExclusions;
  readonly processor: ChatMediaObjectProcessor;
  readonly publicStore: MediaObjectStore;
  readonly invalidations: InvalidationQueue | null;
  readonly report: BackfillReport;
  readonly random: () => number;
  readonly now: () => number;
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
 * exclusions and processes chat images with bounded concurrency. `--limit`
 * stops after that many images; `--sample` picks a uniform random sample
 * of all chat images and processes only those.
 */
export class ChatMediaScan {
  private readonly logger = Logger.get('CHAT_MEDIA_BACKFILL');
  private readonly seenKeys = new Set<string>();
  private readonly reservoir: ChatMediaTarget[] = [];
  private imagesSeen = 0;
  private imagesTaken = 0;
  private lastRefresh = 0;

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
      await this.processImages(targets);
      await this.probeVideos(videos);
      await this.flushInvalidations();
      if (last !== null && this.options.sample === null) {
        this.deps.report.nextCursor = formatCursor({
          phase: page.phase,
          after: last
        });
      }
      if (stopped) {
        completed = false;
        break;
      }
    }
    if (this.options.sample !== null) {
      await this.processImages(this.reservoir, true);
      await this.flushInvalidations();
      return false;
    }
    return completed;
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
      if (target.kind === 'video') videos.push(target);
      else this.takeImage(target, targets);
    }
    return { targets, videos, last, stopped: false };
  }

  private limitReached(): boolean {
    return (
      this.options.limit !== null && this.imagesTaken >= this.options.limit
    );
  }

  private takeImage(target: ChatMediaTarget, targets: ChatMediaTarget[]): void {
    this.imagesSeen++;
    const sample = this.options.sample;
    if (sample === null) {
      this.imagesTaken++;
      targets.push(target);
    } else if (this.reservoir.length < sample) {
      this.reservoir.push(target);
    } else {
      const slot = Math.floor(this.deps.random() * this.imagesSeen);
      if (slot < sample) this.reservoir[slot] = target;
    }
  }

  private async processImages(targets: ChatMediaTarget[], sample = false) {
    await forEachConcurrent(
      targets,
      async (target) => {
        try {
          const outcome = await this.deps.processor.processImage(target);
          this.deps.report.recordImageOutcome(target, outcome);
          if (sample) this.deps.report.recordSample(target, outcome);
        } catch (error) {
          this.logger.warn(`Failed to process ${target.key}: ${String(error)}`);
          this.deps.report.recordFailure(target.key, error);
          if (sample) this.deps.report.recordSample(target, null);
        }
      },
      { concurrency: this.options.concurrency }
    );
  }

  private async probeVideos(videos: ChatMediaTarget[]): Promise<void> {
    const report = this.deps.report.videos;
    report.chat_videos += videos.length;
    if (!this.options.probeVideos) return;
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
