import {
  BackfillReport,
  KeyList,
  REPORT_KEY_LIST_LIMIT
} from './backfill-report';
import { ChatMediaSource, ChatMediaTarget } from './chat-media-candidates';
import { ObjectSkipReason } from './chat-media-object-processor';
import { AmbiguityReason, ExclusionReason } from './media-exclusion-index';
import { CleanState, MetadataCategory } from './metadata-category';

const target = (key: string): ChatMediaTarget => ({
  key,
  kind: 'image',
  source: ChatMediaSource.DROP_MEDIA,
  urls: [],
  inDirectMessage: false,
  isReply: false
});

describe('BackfillReport', () => {
  it('counts outcomes, categories and bytes with keys only', () => {
    const report = new BackfillReport(
      'run',
      'scan',
      'dry-run',
      'prod',
      {},
      new Date(0)
    );
    report.recordRow('drop_media', {
      kind: 'skipped',
      key: 'drops/e/a.png',
      reasons: [
        ExclusionReason.DECISION_ENTRY_MEDIA,
        AmbiguityReason.ORPHAN_DROP_MEDIA
      ]
    });
    report.recordRow('drop_media', {
      kind: 'skipped',
      key: 'drops/o/a.png',
      reasons: [AmbiguityReason.ORPHAN_DROP_MEDIA]
    });
    report.recordImageOutcome(target('drops/a/1.jpg'), {
      kind: 'rewrite',
      categories: [MetadataCategory.GPS, MetadataCategory.SERIAL],
      originalSize: 100,
      strippedSize: 60,
      gainMapsKept: 1,
      written: false
    });
    report.recordImageOutcome(target('drops/a/2.jpg'), {
      kind: 'clean',
      state: CleanState.ORIENTATION_ONLY,
      size: 10
    });
    report.recordImageOutcome(target('drops/a/3.jpg'), {
      kind: 'skipped',
      reason: ObjectSkipReason.VERIFICATION_FAILED,
      categories: [MetadataCategory.GPS],
      size: 5
    });
    report.finish(new Date(1), true);
    const json = report.toJSON();

    expect(json.selection.excluded).toEqual({ decision_entry_media: 1 });
    expect(json.selection.ambiguous).toEqual({ orphan_drop_media: 1 });
    expect(json.categories).toEqual({ gps: 2, serial: 1, orientation_only: 1 });
    expect(json.objects).toMatchObject({
      inspected: 3,
      to_rewrite: 1,
      gain_maps_kept: 1,
      skipped: { verification_failed: 1 },
      unchanged: { orientation_only: 1 }
    });
    expect(json.bytes).toEqual({
      downloaded: 115,
      to_rewrite_original: 100,
      to_rewrite_stripped: 60
    });
    expect(JSON.parse(JSON.stringify(json)).keys.skipped).toEqual({
      verification_failed: { keys: ['drops/a/3.jpg'] }
    });
    expect(json.completed).toBe(true);
  });

  it('caps key lists but keeps exact counts', () => {
    const list = new KeyList();
    for (let index = 0; index < REPORT_KEY_LIST_LIMIT + 3; index++)
      list.add(`k${index}`);
    expect(list.keys).toHaveLength(REPORT_KEY_LIST_LIMIT);
    expect(list.toJSON()).toMatchObject({ truncated: 3 });
  });
});
