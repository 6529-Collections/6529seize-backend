import { publicMediaKey } from '@/drops/drop-media-purpose';
import { DropType } from '@/entities/IDrop';
import { DropMediaUploadPurpose } from '@/entities/IDropMediaUpload';
import {
  ChatMediaBackfillDb,
  DropTextRow,
  NonChatDropRow
} from './chat-media-backfill.db';
import {
  AmbiguityReason,
  ExclusionReason,
  MediaExclusionIndex,
  SkipReason
} from './media-exclusion-index';
import { extractMediaKeyReferences, textOf } from './media-references';

const DECISION_ENTRY_DROP_TYPES: ReadonlySet<string> = new Set([
  DropType.PARTICIPATORY,
  DropType.WINNER,
  DropType.COMPETITION
]);
const KNOWN_UPLOAD_PURPOSES: ReadonlySet<string> = new Set(
  Object.values(DropMediaUploadPurpose)
);

interface DropReasons {
  readonly media: SkipReason;
  readonly text: SkipReason;
}

const DECISION_ENTRY: DropReasons = {
  media: ExclusionReason.DECISION_ENTRY_MEDIA,
  text: ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
};

export interface ExclusionStats {
  decision_entry_drops: number;
  ambiguous_drops: number;
  decision_entry_uploads: number;
  unknown_purpose_uploads: number;
  uploads_scanned: number;
  minting_claims: number;
  orphan_drop_media_rows: number;
  excluded_keys: number;
}

/**
 * A decision entry is a participatory drop that is not a reply. Winners and
 * native competition entries are decision entries too. A non-chat reply, which
 * no current flow creates, or an unknown type is ambiguous; either way the
 * drop's media stays untouched.
 */
export function dropReasons(drop: NonChatDropRow): DropReasons {
  if (drop.reply_to_drop_id) {
    return {
      media: AmbiguityReason.NON_CHAT_REPLY,
      text: AmbiguityReason.NON_CHAT_REPLY
    };
  }
  if (!DECISION_ENTRY_DROP_TYPES.has(drop.drop_type)) {
    return {
      media: AmbiguityReason.UNKNOWN_DROP_TYPE,
      text: AmbiguityReason.UNKNOWN_DROP_TYPE
    };
  }
  return DECISION_ENTRY;
}

/**
 * Builds the set of object keys a decision entry uses or may use, from every
 * place this data lives: the entry's media rows, URLs anywhere in its
 * metadata (the Memes `additional_media` JSON holds supporting, preview and
 * promo media), its parts and native entry content, decision-entry uploads,
 * and claim artwork. Media rows of deleted drops are ambiguous.
 */
export class DecisionEntryExclusions {
  readonly index = new MediaExclusionIndex();
  readonly stats: ExclusionStats = {
    decision_entry_drops: 0,
    ambiguous_drops: 0,
    decision_entry_uploads: 0,
    unknown_purpose_uploads: 0,
    uploads_scanned: 0,
    minting_claims: 0,
    orphan_drop_media_rows: 0,
    excluded_keys: 0
  };
  /** Public keys of every upload record, when the environment guard needs them. */
  uploadKeys: Set<string> | null = null;
  private lastNonChatSerialNo = 0;
  private readonly indexedDropIds = new Set<string>();

  constructor(
    private readonly db: ChatMediaBackfillDb,
    private readonly pageSize = 1000
  ) {}

  async build({
    collectUploadKeys
  }: {
    collectUploadKeys: boolean;
  }): Promise<void> {
    if (collectUploadKeys) this.uploadKeys = new Set();
    await this.indexNewNonChatDrops();
    await this.indexCompetitionEntries();
    await this.indexUploads();
    await this.indexMintingClaims();
    await this.indexOrphanDropMedia();
    this.stats.excluded_keys = this.index.size;
  }

  /**
   * Picks up decision entries created since the last scan. New entries only
   * add drops, so the incremental drop scan covers their media and text.
   */
  async refresh(): Promise<void> {
    await this.indexNewNonChatDrops();
    this.stats.excluded_keys = this.index.size;
  }

  private async indexNewNonChatDrops(): Promise<void> {
    for (;;) {
      const drops = await this.db.findNonChatDropsAfter(
        this.lastNonChatSerialNo,
        this.pageSize
      );
      if (!drops.length) return;
      this.lastNonChatSerialNo = Number(drops[drops.length - 1].serial_no);
      const reasonsByDrop = new Map<string, DropReasons>();
      for (const drop of drops) {
        const reasons = dropReasons(drop);
        reasonsByDrop.set(drop.id, reasons);
        if (reasons === DECISION_ENTRY) this.stats.decision_entry_drops++;
        else this.stats.ambiguous_drops++;
      }
      await this.indexDrops(reasonsByDrop);
    }
  }

  private async indexCompetitionEntries(): Promise<void> {
    let afterId = '';
    for (;;) {
      const entries = await this.db.findCompetitionEntryDropsAfter(
        afterId,
        this.pageSize
      );
      if (!entries.length) return;
      afterId = entries[entries.length - 1].id;
      const reasonsByDrop = new Map<string, DropReasons>();
      for (const entry of entries) {
        if (!this.indexedDropIds.has(entry.drop_id)) {
          reasonsByDrop.set(entry.drop_id, DECISION_ENTRY);
        }
      }
      this.stats.decision_entry_drops += reasonsByDrop.size;
      await this.indexDrops(reasonsByDrop);
    }
  }

  private async indexDrops(reasonsByDrop: Map<string, DropReasons>) {
    const dropIds = Array.from(reasonsByDrop.keys());
    if (!dropIds.length) return;
    dropIds.forEach((id) => this.indexedDropIds.add(id));
    const [media, texts] = await Promise.all([
      this.db.findMediaUrlsOfDrops(dropIds),
      this.db.findTextsOfDrops(dropIds)
    ]);
    this.indexRows(media, (row) => reasonsByDrop.get(row.drop_id)!.media);
    this.indexRows(texts, (row) => reasonsByDrop.get(row.drop_id)!.text);
  }

  private indexRows(
    rows: DropTextRow[],
    reasonOf: (row: DropTextRow) => SkipReason
  ): void {
    for (const row of rows) {
      this.indexUrlOrText(textOf(row.text), reasonOf(row));
    }
  }

  private indexUrlOrText(value: string, reason: SkipReason): void {
    const key = publicMediaKey(value);
    if (key) this.index.addKey(key, reason);
    for (const reference of extractMediaKeyReferences(value)) {
      this.index.addTextReference(reference, reason);
    }
  }

  private async indexUploads(): Promise<void> {
    let afterId = '';
    for (;;) {
      const uploads = await this.db.findUploadsAfter(afterId, this.pageSize);
      if (!uploads.length) return;
      afterId = uploads[uploads.length - 1].id;
      for (const upload of uploads) {
        this.stats.uploads_scanned++;
        this.uploadKeys?.add(upload.public_key);
        const reason = uploadReason(upload.purpose);
        if (!reason) continue;
        if (reason === ExclusionReason.DECISION_ENTRY_UPLOAD) {
          this.stats.decision_entry_uploads++;
        } else {
          this.stats.unknown_purpose_uploads++;
        }
        this.index.addKey(upload.public_key, reason);
        this.indexUrlOrText(upload.public_url, reason);
      }
    }
  }

  private async indexMintingClaims(): Promise<void> {
    let afterDropId = '';
    for (;;) {
      const claims = await this.db.findMintingClaimMediaAfter(
        afterDropId,
        this.pageSize
      );
      if (!claims.length) return;
      afterDropId = claims[claims.length - 1].drop_id;
      for (const claim of claims) {
        this.stats.minting_claims++;
        for (const url of [claim.image_url, claim.animation_url]) {
          if (url)
            this.indexUrlOrText(url, ExclusionReason.MINTING_CLAIM_MEDIA);
        }
      }
    }
  }

  private async indexOrphanDropMedia(): Promise<void> {
    let afterId = 0;
    for (;;) {
      const { rows, lastId } = await this.db.findOrphanDropMediaAfter(
        afterId,
        this.pageSize
      );
      if (lastId === null) return;
      afterId = lastId;
      for (const row of rows) {
        this.stats.orphan_drop_media_rows++;
        this.indexUrlOrText(row.url, AmbiguityReason.ORPHAN_DROP_MEDIA);
      }
    }
  }
}

function uploadReason(purpose: string | null): SkipReason | null {
  if (purpose === null || purpose === DropMediaUploadPurpose.CHAT) return null;
  if (purpose === DropMediaUploadPurpose.DECISION_ENTRY) {
    return ExclusionReason.DECISION_ENTRY_UPLOAD;
  }
  return KNOWN_UPLOAD_PURPOSES.has(purpose)
    ? null
    : AmbiguityReason.UNKNOWN_UPLOAD_PURPOSE;
}
