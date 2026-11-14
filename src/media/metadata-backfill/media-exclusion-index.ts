import { isReferencePrefixOf, keyFolder } from './media-references';

/** Why media must keep its bytes: it belongs to, or may belong to, a decision entry. */
export enum ExclusionReason {
  /** A `drop_medias` row of a decision entry (any non-chat drop). */
  DECISION_ENTRY_MEDIA = 'decision_entry_media',
  /** Named in a decision entry's metadata, parts or native entry content. */
  DECISION_ENTRY_TEXT_REFERENCE = 'decision_entry_text_reference',
  /** Uploaded with `drop_media_uploads.purpose = decision_entry`. */
  DECISION_ENTRY_UPLOAD = 'decision_entry_upload',
  /** Claim artwork prepared from a decision entry. */
  MINTING_CLAIM_MEDIA = 'minting_claim_media'
}

/** The classification is unclear, so the media is skipped and reported. */
export enum AmbiguityReason {
  /** A `drop_medias` row whose drop no longer exists. */
  ORPHAN_DROP_MEDIA = 'orphan_drop_media',
  /** An upload purpose that is neither `chat` nor `decision_entry`. */
  UNKNOWN_UPLOAD_PURPOSE = 'unknown_upload_purpose',
  /** A non-chat drop that is a reply, which no current flow creates. */
  NON_CHAT_REPLY = 'non_chat_reply',
  /** A drop type this tool does not know. */
  UNKNOWN_DROP_TYPE = 'unknown_drop_type',
  /** A wave picture outside the `waves/` prefix. */
  WAVE_PICTURE_OUTSIDE_WAVES_PREFIX = 'wave_picture_outside_waves_prefix'
}

export type SkipReason = ExclusionReason | AmbiguityReason;

const AMBIGUITY_REASONS: ReadonlySet<string> = new Set(
  Object.values(AmbiguityReason)
);

export function isAmbiguityReason(reason: SkipReason): boolean {
  return AMBIGUITY_REASONS.has(reason);
}

/**
 * Every object key that must not be rewritten, with the reasons. Keys from
 * structured columns match exactly; references found in free text also match
 * the keys they are a truncated prefix of.
 */
export class MediaExclusionIndex {
  private readonly exact = new Map<string, Set<SkipReason>>();
  private readonly referencesByFolder = new Map<
    string,
    Map<string, Set<SkipReason>>
  >();

  addKey(key: string, reason: SkipReason): void {
    addReason(this.exact, key, reason);
  }

  addTextReference(reference: string, reason: SkipReason): void {
    this.addKey(reference, reason);
    const folder = keyFolder(reference);
    if (!folder) return;
    let references = this.referencesByFolder.get(folder);
    if (!references) {
      references = new Map();
      this.referencesByFolder.set(folder, references);
    }
    addReason(references, reference, reason);
  }

  /** Reasons to leave the key alone, sorted; empty when it may be rewritten. */
  reasonsFor(key: string): SkipReason[] {
    const reasons = new Set<SkipReason>(this.exact.get(key) ?? []);
    const folder = keyFolder(key);
    const references = folder ? this.referencesByFolder.get(folder) : undefined;
    references?.forEach((referenceReasons, reference) => {
      if (isReferencePrefixOf(reference, key)) {
        referenceReasons.forEach((reason) => reasons.add(reason));
      }
    });
    return Array.from(reasons).sort((a, b) => a.localeCompare(b));
  }

  get size(): number {
    return this.exact.size;
  }
}

function addReason(
  map: Map<string, Set<SkipReason>>,
  key: string,
  reason: SkipReason
): void {
  let reasons = map.get(key);
  if (!reasons) {
    reasons = new Set();
    map.set(key, reasons);
  }
  reasons.add(reason);
}
