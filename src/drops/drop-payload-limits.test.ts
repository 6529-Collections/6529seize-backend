import fc from 'fast-check';
import {
  DROP_MAX_ATTACHMENTS,
  DROP_MAX_MEDIA,
  DROP_MAX_METADATA_ENTRIES,
  DROP_MAX_MENTIONED_USERS,
  DROP_MAX_MENTIONED_WAVES,
  DROP_MAX_PARTS,
  DROP_MAX_REFERENCED_NFTS,
  DROP_MEDIA_MIME_TYPE_MAX_LENGTH,
  DROP_MEDIA_UPLOAD_ID_MAX_LENGTH,
  DROP_MEDIA_URL_MAX_LENGTH,
  DROP_PART_MAX_ATTACHMENTS,
  DROP_PART_MAX_MEDIA,
  DropPayload,
  formatDropPayloadLimitViolation,
  getDropPayloadLimitViolation
} from './drop-payload-limits';

const RUNS = { numRuns: 25 };

function items(count: number): unknown[] {
  return Array.from({ length: count }, () => ({}));
}

function emptyParts(count: number): DropPayload['parts'] {
  return Array.from({ length: count }, () => ({}));
}

function media(count: number, overrides: Record<string, string> = {}) {
  return Array.from({ length: count }, () => ({
    url: 'https://example.com/a.png',
    mime_type: 'image/png',
    ...overrides
  }));
}

function drop(overrides: Partial<DropPayload> = {}): DropPayload {
  return {
    parts: [{ media: [], attachments: [] }],
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    referenced_nfts: [],
    ...overrides
  };
}

const TOP_LEVEL_LIST_CAPS = [
  ['parts', DROP_MAX_PARTS],
  ['metadata', DROP_MAX_METADATA_ENTRIES],
  ['mentioned_users', DROP_MAX_MENTIONED_USERS],
  ['mentioned_waves', DROP_MAX_MENTIONED_WAVES],
  ['referenced_nfts', DROP_MAX_REFERENCED_NFTS]
] as const;

describe('drop payload limits', () => {
  it('accepts an empty drop and the shapes internal callers produce', () => {
    expect(getDropPayloadLimitViolation(drop())).toBeNull();
    expect(
      getDropPayloadLimitViolation({
        parts: [{ media: [] }],
        mentioned_users: [{}]
      })
    ).toBeNull();
  });

  it('tolerates omitted or null optional lists', () => {
    expect(
      getDropPayloadLimitViolation({
        parts: [{}, { media: null, attachments: null }],
        metadata: null,
        mentioned_users: null,
        mentioned_waves: undefined,
        referenced_nfts: null
      })
    ).toBeNull();
  });

  it.each(TOP_LEVEL_LIST_CAPS)(
    'accepts any %s count up to the cap and rejects anything above it',
    (field, cap) => {
      const build = (count: number): DropPayload =>
        field === 'parts'
          ? drop({ parts: emptyParts(count) })
          : drop({ [field]: items(count) });
      fc.assert(
        fc.property(fc.integer({ min: 0, max: cap }), (count) => {
          expect(getDropPayloadLimitViolation(build(count))).toBeNull();
        }),
        RUNS
      );
      expect(getDropPayloadLimitViolation(build(cap))).toBeNull();
      fc.assert(
        fc.property(fc.integer({ min: cap + 1, max: cap * 3 }), (count) => {
          expect(getDropPayloadLimitViolation(build(count))).toEqual({
            kind: 'count',
            path: field,
            limit: cap
          });
        }),
        RUNS
      );
      expect(getDropPayloadLimitViolation(build(cap + 1))).not.toBeNull();
    }
  );

  it('accepts per-part media up to the cap and rejects above it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: DROP_PART_MAX_MEDIA }), (count) => {
        expect(
          getDropPayloadLimitViolation(
            drop({ parts: [{ media: media(count) }] })
          )
        ).toBeNull();
      }),
      RUNS
    );
    fc.assert(
      fc.property(
        fc.integer({
          min: DROP_PART_MAX_MEDIA + 1,
          max: DROP_PART_MAX_MEDIA * 4
        }),
        fc.integer({ min: 0, max: 3 }),
        (count, precedingParts) => {
          const parts = [
            ...Array.from({ length: precedingParts }, () => ({})),
            { media: media(count) }
          ];
          expect(getDropPayloadLimitViolation(drop({ parts }))).toEqual({
            kind: 'count',
            path: `parts[${precedingParts}].media`,
            limit: DROP_PART_MAX_MEDIA
          });
        }
      ),
      RUNS
    );
  });

  it('accepts per-part attachments up to the cap and rejects above it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DROP_PART_MAX_ATTACHMENTS }),
        (count) => {
          expect(
            getDropPayloadLimitViolation(
              drop({ parts: [{ attachments: items(count) }] })
            )
          ).toBeNull();
        }
      ),
      RUNS
    );
    fc.assert(
      fc.property(
        fc.integer({
          min: DROP_PART_MAX_ATTACHMENTS + 1,
          max: DROP_PART_MAX_ATTACHMENTS * 4
        }),
        (count) => {
          expect(
            getDropPayloadLimitViolation(
              drop({ parts: [{ attachments: items(count) }] })
            )
          ).toEqual({
            kind: 'count',
            path: 'parts[0].attachments',
            limit: DROP_PART_MAX_ATTACHMENTS
          });
        }
      ),
      RUNS
    );
  });

  it('caps media across the whole drop even when every part is within its own cap', () => {
    const partsOf = (total: number) => {
      const parts: Array<{ media: ReturnType<typeof media> }> = [];
      for (let left = total; left > 0; left -= DROP_PART_MAX_MEDIA) {
        parts.push({ media: media(Math.min(left, DROP_PART_MAX_MEDIA)) });
      }
      return parts;
    };
    expect(
      getDropPayloadLimitViolation(drop({ parts: partsOf(DROP_MAX_MEDIA) }))
    ).toBeNull();
    expect(
      getDropPayloadLimitViolation(drop({ parts: partsOf(DROP_MAX_MEDIA + 1) }))
    ).toEqual({ kind: 'total-count', field: 'media', limit: DROP_MAX_MEDIA });
  });

  it('caps attachments across the whole drop even when every part is within its own cap', () => {
    const partsOf = (total: number) => {
      const parts: Array<{ attachments: unknown[] }> = [];
      for (let left = total; left > 0; left -= DROP_PART_MAX_ATTACHMENTS) {
        parts.push({
          attachments: items(Math.min(left, DROP_PART_MAX_ATTACHMENTS))
        });
      }
      return parts;
    };
    expect(
      getDropPayloadLimitViolation(
        drop({ parts: partsOf(DROP_MAX_ATTACHMENTS) })
      )
    ).toBeNull();
    expect(
      getDropPayloadLimitViolation(
        drop({ parts: partsOf(DROP_MAX_ATTACHMENTS + 1) })
      )
    ).toEqual({
      kind: 'total-count',
      field: 'attachments',
      limit: DROP_MAX_ATTACHMENTS
    });
  });

  it.each([
    ['url', DROP_MEDIA_URL_MAX_LENGTH],
    ['mime_type', DROP_MEDIA_MIME_TYPE_MAX_LENGTH],
    ['media_upload_id', DROP_MEDIA_UPLOAD_ID_MAX_LENGTH]
  ] as const)(
    'accepts media %s up to the cap and rejects one character above it',
    (field, cap) => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: cap }), (length) => {
          expect(
            getDropPayloadLimitViolation(
              drop({
                parts: [{ media: media(1, { [field]: 'a'.repeat(length) }) }]
              })
            )
          ).toBeNull();
        }),
        RUNS
      );
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 500 }), (extra) => {
          expect(
            getDropPayloadLimitViolation(
              drop({
                parts: [
                  { media: [] },
                  {
                    media: media(2).map((it, index) =>
                      index === 1
                        ? { ...it, [field]: 'a'.repeat(cap + extra) }
                        : it
                    )
                  }
                ]
              })
            )
          ).toEqual({
            kind: 'length',
            path: `parts[1].media[1].${field}`,
            limit: cap
          });
        }),
        RUNS
      );
    }
  );

  it('checks list sizes before walking parts so oversized input is rejected cheaply', () => {
    const hugeParts = items(DROP_MAX_PARTS + 1).map(() => ({
      media: media(DROP_PART_MAX_MEDIA + 1)
    }));
    expect(getDropPayloadLimitViolation(drop({ parts: hugeParts }))).toEqual({
      kind: 'count',
      path: 'parts',
      limit: DROP_MAX_PARTS
    });
  });

  it('formats clear messages for every violation kind', () => {
    expect(
      formatDropPayloadLimitViolation({
        kind: 'count',
        path: 'parts[2].media',
        limit: 20
      })
    ).toBe('parts[2].media must contain at most 20 items');
    expect(
      formatDropPayloadLimitViolation({
        kind: 'length',
        path: 'parts[0].media[1].url',
        limit: 2000
      })
    ).toBe('parts[0].media[1].url must be at most 2000 characters long');
    expect(
      formatDropPayloadLimitViolation({
        kind: 'total-count',
        field: 'media',
        limit: 100
      })
    ).toBe(
      'media across all drop parts must contain at most 100 items in total'
    );
  });
});
