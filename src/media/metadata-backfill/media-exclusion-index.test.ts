import {
  AmbiguityReason,
  ExclusionReason,
  isAmbiguityReason,
  MediaExclusionIndex
} from './media-exclusion-index';

describe('MediaExclusionIndex', () => {
  it('matches structured keys exactly', () => {
    const index = new MediaExclusionIndex();
    index.addKey('drops/a/art.png', ExclusionReason.DECISION_ENTRY_MEDIA);
    expect(index.reasonsFor('drops/a/art.png')).toEqual([
      ExclusionReason.DECISION_ENTRY_MEDIA
    ]);
    expect(index.reasonsFor('drops/a/art.png.jpg')).toEqual([]);
    expect(index.reasonsFor('drops/a/other.png')).toEqual([]);
  });

  it('matches keys that a text reference is a truncated prefix of', () => {
    const index = new MediaExclusionIndex();
    index.addTextReference(
      'drops/author_1/My',
      ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
    );
    index.addTextReference('drops/author_2', AmbiguityReason.NON_CHAT_REPLY);
    index.addTextReference('drops/upload-3/', AmbiguityReason.NON_CHAT_REPLY);
    expect(index.reasonsFor('drops/author_1/My Photo.jpg')).toEqual([
      ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
    ]);
    expect(index.reasonsFor('drops/author_1/Other.jpg')).toEqual([]);
    // Without its folder slash a reference matches only exactly.
    expect(index.reasonsFor('drops/author_2/a.png')).toEqual([]);
    // Cut off at the folder, it keeps the whole folder.
    expect(index.reasonsFor('drops/upload-3/(1).png')).toEqual([
      AmbiguityReason.NON_CHAT_REPLY
    ]);
  });

  it('collects every reason, sorted', () => {
    const index = new MediaExclusionIndex();
    index.addKey('drops/a/b.png', ExclusionReason.MINTING_CLAIM_MEDIA);
    index.addTextReference(
      'drops/a/b.png',
      ExclusionReason.DECISION_ENTRY_UPLOAD
    );
    expect(index.reasonsFor('drops/a/b.png')).toEqual([
      ExclusionReason.DECISION_ENTRY_UPLOAD,
      ExclusionReason.MINTING_CLAIM_MEDIA
    ]);
    expect(index.size).toBe(1);
  });

  it('tells ambiguity from exclusion', () => {
    expect(isAmbiguityReason(AmbiguityReason.ORPHAN_DROP_MEDIA)).toBe(true);
    expect(isAmbiguityReason(ExclusionReason.DECISION_ENTRY_MEDIA)).toBe(false);
  });
});
