import fc from 'fast-check';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  DROP_PART_MAX_UTF16_CODE_UNITS,
  DROP_PART_MAX_UTF8_BYTES,
  DROP_TOTAL_MAX_UTF16_CODE_UNITS,
  NewDropSchema,
  NewWaveDropSchema,
  UpdateDropSchema
} from '@/api/drops/drop.validator';
import {
  DROP_ATTACHMENT_ID_MAX_LENGTH,
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
  DROP_MENTIONED_WAVE_NAME_MAX_LENGTH,
  DROP_PART_MAX_ATTACHMENTS,
  DROP_PART_MAX_MEDIA,
  DROP_REFERENCED_NFT_NAME_MAX_LENGTH,
  DROP_REFERENCED_NFT_TOKEN_MAX_LENGTH
} from '@/drops/drop-payload-limits';

describe('NewDropSchema', () => {
  const futureTimestamp = Date.now() + 60_000;

  function createDropWithMetadata(dataKey: string, dataValue: string) {
    return {
      wave_id: 'wave-1',
      drop_type: ApiDropType.Participatory,
      title: null,
      parts: [
        {
          content: 'Submission',
          media: [],
          attachments: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [
        {
          data_key: dataKey,
          data_value: dataValue
        }
      ],
      mentioned_groups: [],
      signature: null
    };
  }

  it('accepts metadata keys up to 500 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('a'.repeat(500), 'value')
    );

    expect(result.error).toBeUndefined();
  });

  it('normalizes structured fields without trimming freeform part content', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata(' artist ', '  6529er  '),
      title: '  The Loom  ',
      parts: [
        {
          content: '  keep chat text as typed  ',
          media: [],
          attachments: []
        }
      ]
    });

    expect(result.error).toBeUndefined();
    expect(result.value.title).toBe('The Loom');
    expect(result.value.parts[0].content).toBe('  keep chat text as typed  ');
    expect(result.value.metadata[0]).toMatchObject({
      data_key: 'artist',
      data_value: '6529er'
    });

    const emptyTitleResult = NewDropSchema.validate({
      ...createDropWithMetadata('artist', '6529er'),
      title: '   '
    });

    expect(emptyTitleResult.error).toBeUndefined();
    expect(emptyTitleResult.value.title).toBeNull();
  });

  it('rejects metadata fields that are empty after trimming', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata(' artist ', '   ')
    );

    expect(result.error?.message).toContain(
      '"metadata[0].data_value" is not allowed to be empty'
    );
  });

  it('rejects metadata keys over 500 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('a'.repeat(501), 'value')
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain(
      '"metadata[0].data_key" length must be less than or equal to 500 characters long'
    );
  });

  it('rejects metadata values over 5000 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('artist', 'a'.repeat(5001))
    );

    expect(result.error?.message).toContain(
      'metadata value for "artist" must be less than or equal to 5000 characters long'
    );
  });

  it('accepts metadata values up to 5000 characters by default', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('artist', 'a'.repeat(5000))
    );

    expect(result.error).toBeUndefined();
  });

  it('rejects metadata title values over 255 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('title', 'a'.repeat(256))
    );

    expect(result.error?.message).toContain(
      'metadata value for "title" must be less than or equal to 255 characters long'
    );
  });

  it('accepts metadata title values up to 255 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('title', 'a'.repeat(255))
    );

    expect(result.error).toBeUndefined();
  });

  it('accepts metadata description values up to 8000 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('description', 'a'.repeat(8000))
    );

    expect(result.error).toBeUndefined();
  });

  it('rejects metadata description values over 8000 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('description', 'a'.repeat(8001))
    );

    expect(result.error?.message).toContain(
      'metadata value for "description" must be less than or equal to 8000 characters long'
    );
  });

  it('accepts additional action promise flag for participatory drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      is_additional_action_promised: true
    });

    expect(result.error).toBeUndefined();
    expect(result.value.is_additional_action_promised).toBe(true);
  });

  it('allows participatory drops to omit additional action promise flag', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('artist', 'Artist')
    );

    expect(result.error).toBeUndefined();
    expect(result.value.is_additional_action_promised).toBeUndefined();
  });

  it('rejects additional action promise flag for chat drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      is_additional_action_promised: false
    });

    expect(result.error?.message).toContain(
      '"is_additional_action_promised" is not allowed'
    );
  });

  it('rejects additional action promise flag when drop type defaults to chat', () => {
    const { drop_type, ...chatDrop } = createDropWithMetadata(
      'artist',
      'Artist'
    );
    const result = NewDropSchema.validate({
      ...chatDrop,
      is_additional_action_promised: true
    });

    expect(drop_type).toBe(ApiDropType.Participatory);
    expect(result.error?.message).toContain(
      '"is_additional_action_promised" is not allowed'
    );
  });

  it('accepts polls for chat drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        closing_time: futureTimestamp
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.value.poll).toMatchObject({
      options: ['First', 'Second'],
      multichoice: false,
      anonymous: false,
      only_droppers_can_respond: false,
      closing_time: futureTimestamp
    });
  });

  it.each([true, false])(
    'accepts hide_link_preview=%s on create requests',
    (hideLinkPreview) => {
      const result = NewDropSchema.validate({
        ...createDropWithMetadata('artist', 'Artist'),
        drop_type: ApiDropType.Chat,
        hide_link_preview: hideLinkPreview
      });

      expect(result.error).toBeUndefined();
      expect(result.value.hide_link_preview).toBe(hideLinkPreview);
    }
  );

  it.each([true, false])(
    'accepts hide_link_preview=%s on participatory create requests',
    (hideLinkPreview) => {
      const result = NewDropSchema.validate({
        ...createDropWithMetadata('artist', 'Artist'),
        hide_link_preview: hideLinkPreview
      });

      expect(result.error).toBeUndefined();
      expect(result.value.drop_type).toBe(ApiDropType.Participatory);
      expect(result.value.hide_link_preview).toBe(hideLinkPreview);
    }
  );

  it('keeps hidden link preview unset when omitted on create requests', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat
    });

    expect(result.error).toBeUndefined();
    expect(result.value.hide_link_preview).toBeUndefined();
  });

  it('accepts anonymous polls for chat drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        anonymous: true,
        closing_time: futureTimestamp
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.value.poll).toMatchObject({
      anonymous: true
    });
  });

  it('accepts polls restricted to wave chat participants for chat drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        only_droppers_can_respond: true,
        closing_time: futureTimestamp
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.value.poll).toMatchObject({
      only_droppers_can_respond: true
    });
  });

  it('rejects polls with invalid only_droppers_can_respond values', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        only_droppers_can_respond: 'invalid',
        closing_time: futureTimestamp
      }
    });

    expect(result.error?.message).toContain(
      '"poll.only_droppers_can_respond" must be a boolean'
    );
  });

  it('rejects polls with invalid anonymous values', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        anonymous: 'invalid',
        closing_time: futureTimestamp
      }
    });

    expect(result.error?.message).toContain(
      '"poll.anonymous" must be a boolean'
    );
  });

  it('rejects polls for participatory drops', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        closing_time: futureTimestamp
      }
    });

    expect(result.error?.message).toContain('"poll" is not allowed');
  });

  it('rejects polls with fewer than two options', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['Only'],
        multichoice: false,
        closing_time: futureTimestamp
      }
    });

    expect(result.error?.message).toContain(
      '"poll.options" must contain at least 2 items'
    );
  });

  it('rejects polls with duplicate options', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['Same', 'Same'],
        multichoice: false,
        closing_time: futureTimestamp
      }
    });

    expect(result.error?.message).toContain('duplicate');
  });

  it('rejects polls with past closing time', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      poll: {
        options: ['First', 'Second'],
        multichoice: false,
        closing_time: Date.now() - 1
      }
    });

    expect(result.error?.message).toContain(
      'poll closing_time must be in the future'
    );
  });
});

describe('UpdateDropSchema', () => {
  it('rejects hide_link_preview because preview visibility updates use the dedicated endpoint', () => {
    const result = UpdateDropSchema.validate({
      title: 'Updated',
      parts: [
        {
          content: 'Updated content',
          media: [],
          attachments: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      signature: null,
      hide_link_preview: true
    });

    expect(result.error?.message).toContain(
      '"hide_link_preview" is not allowed'
    );
  });
});

describe('shared drop content limits', () => {
  const schemas = [
    [
      'create drop',
      NewDropSchema,
      { wave_id: 'wave-1', drop_type: ApiDropType.Chat }
    ],
    ['update drop', UpdateDropSchema, {}],
    ['create-wave initial drop', NewWaveDropSchema, {}]
  ] as const;

  function validate(
    schema: (typeof schemas)[number][1],
    parts: Array<{ content: string }>
  ) {
    return schema.validate({
      ...(schema === NewDropSchema
        ? { wave_id: 'wave-1', drop_type: ApiDropType.Chat }
        : {}),
      title: null,
      parts,
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      signature: null
    });
  }

  it.each(schemas)(
    '%s accepts exactly %s UTF-16 code units in one part and rejects +1',
    (_name, schema) => {
      const exact = validate(schema, [
        { content: 'a'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS) }
      ]);
      expect(exact.error).toBeUndefined();

      const secret = 'content-that-must-not-appear-in-validation-errors';
      const over = validate(schema, [
        {
          content: 'a'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS + 1) + secret
        }
      ]);
      expect(over.error?.message).toContain('UTF-16 code units');
      expect(over.error?.message).not.toContain(secret);
    }
  );

  it.each(schemas)(
    '%s accepts exactly %s UTF-8 bytes for BMP text and rejects +1 byte',
    (_name, schema) => {
      const exact = validate(schema, [{ content: '漢'.repeat(21_845) }]);
      expect(exact.error).toBeUndefined();

      const over = validate(schema, [{ content: '漢'.repeat(21_846) }]);
      expect(over.error?.message).toContain('UTF-8 bytes');
      expect(over.error?.message).not.toContain('漢');
    }
  );

  it.each(schemas)(
    '%s counts emoji surrogate pairs as two UTF-16 code units',
    (_name, schema) => {
      const exact = validate(schema, [
        { content: '😀'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS / 2) }
      ]);
      expect(exact.error).toBeUndefined();
      expect(exact.value.parts[0].content.length).toBe(
        DROP_PART_MAX_UTF16_CODE_UNITS
      );

      const over = validate(schema, [
        {
          content: '😀'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS / 2) + '😀'
        }
      ]);
      expect(over.error?.message).toContain('UTF-16 code units');
    }
  );

  it.each(schemas)(
    '%s applies the UTF-8 byte boundary to unpaired surrogate code units',
    (_name, schema) => {
      const exact = validate(schema, [
        { content: String.fromCharCode(0xd800).repeat(21_845) }
      ]);
      expect(exact.error).toBeUndefined();

      const over = validate(schema, [
        { content: String.fromCharCode(0xd800).repeat(21_846) }
      ]);
      expect(over.error?.message).toContain('UTF-8 bytes');
    }
  );

  it.each(schemas)(
    '%s accepts exactly %s total UTF-16 code units and rejects +1',
    (_name, schema) => {
      const exact = validate(schema, [
        { content: 'a'.repeat(25_000) },
        { content: 'b'.repeat(25_000) }
      ]);
      expect(exact.error).toBeUndefined();

      const over = validate(schema, [
        { content: 'a'.repeat(25_000) },
        { content: 'b'.repeat(25_000) },
        { content: 'c' }
      ]);
      expect(over.error?.message).toContain('total content');
      expect(over.error?.message).toContain('UTF-16 code units');
    }
  );

  it('uses distinct error messages for the byte and aggregate limits', () => {
    const byteError = validate(NewDropSchema, [
      { content: '漢'.repeat(21_846) }
    ]);
    const aggregateError = validate(NewDropSchema, [
      { content: 'a'.repeat(25_000) },
      { content: 'b'.repeat(25_000) },
      { content: 'c' }
    ]);

    expect(byteError.error?.message).toContain(
      `${DROP_PART_MAX_UTF8_BYTES} UTF-8 bytes`
    );
    expect(aggregateError.error?.message).toContain(
      `${DROP_TOTAL_MAX_UTF16_CODE_UNITS} UTF-16 code units`
    );
    expect(aggregateError.error?.message).not.toContain(
      `${DROP_PART_MAX_UTF8_BYTES} UTF-8 bytes`
    );
  });
});

describe('drop payload limits', () => {
  const schemas = [
    ['create drop', NewDropSchema],
    ['update drop', UpdateDropSchema],
    ['create-wave initial drop', NewWaveDropSchema]
  ] as const;
  const anySchema = fc.constantFrom(...schemas.map(([, schema]) => schema));
  const RUNS = { numRuns: 20 };

  type Schema = (typeof schemas)[number][1];

  function baseDrop(schema: Schema): Record<string, unknown> {
    return {
      ...(schema === NewDropSchema
        ? { wave_id: 'wave-1', drop_type: ApiDropType.Chat }
        : {}),
      title: null,
      parts: [{ content: 'content', media: [], attachments: [] }],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      signature: null
    };
  }

  function validate(schema: Schema, overrides: Record<string, unknown>) {
    return schema.validate({ ...baseDrop(schema), ...overrides });
  }

  function each<T>(count: number, build: (index: number) => T): T[] {
    return Array.from({ length: count }, (_, index) => build(index));
  }

  const part = (index: number) => ({
    content: `part ${index}`,
    media: [],
    attachments: []
  });
  const mediaItem = (index: number) => ({
    mime_type: 'image/png',
    url: `https://example.com/${index}.png`
  });
  const attachment = (index: number) => ({ attachment_id: `att-${index}` });

  const countedFields = [
    [
      'parts',
      DROP_MAX_PARTS,
      (count: number) => ({ parts: each(count, part) })
    ],
    [
      'metadata',
      DROP_MAX_METADATA_ENTRIES,
      (count: number) => ({
        metadata: each(count, (index) => ({
          data_key: `key-${index}`,
          data_value: 'value'
        }))
      })
    ],
    [
      'mentioned_users',
      DROP_MAX_MENTIONED_USERS,
      (count: number) => ({
        mentioned_users: each(count, (index) => ({
          mentioned_profile_id: `profile-${index}`,
          handle_in_content: `handle-${index}`
        }))
      })
    ],
    [
      'mentioned_waves',
      DROP_MAX_MENTIONED_WAVES,
      (count: number) => ({
        mentioned_waves: each(count, (index) => ({
          wave_id: `wave-${index}`,
          wave_name_in_content: `wave ${index}`
        }))
      })
    ],
    [
      'referenced_nfts',
      DROP_MAX_REFERENCED_NFTS,
      (count: number) => ({
        referenced_nfts: each(count, (index) => ({
          contract: `0x${'1'.repeat(40)}`,
          token: `${index}`,
          name: `nft ${index}`
        }))
      })
    ]
  ] as const;

  it.each(countedFields)(
    'accepts up to the %s cap of %s items and rejects the next one on every drop schema',
    (field, cap, build) => {
      fc.assert(
        fc.property(
          anySchema,
          fc.integer({ min: field === 'parts' ? 1 : 0, max: cap }),
          (schema, count) => {
            expect(validate(schema, build(count)).error).toBeUndefined();
          }
        ),
        RUNS
      );
      fc.assert(
        fc.property(
          anySchema,
          fc.integer({ min: 1, max: 40 }),
          (schema, extra) => {
            expect(
              validate(schema, build(cap + extra)).error?.message
            ).toContain(
              `"${field}" must contain less than or equal to ${cap} items`
            );
          }
        ),
        RUNS
      );
    }
  );

  it.each(schemas)(
    '%s accepts exactly the cap and rejects cap + 1 for every counted field',
    (_name, schema) => {
      for (const [field, cap, build] of countedFields) {
        expect(validate(schema, build(cap)).error).toBeUndefined();
        expect(validate(schema, build(cap + 1)).error?.message).toContain(
          `"${field}" must contain less than or equal to ${cap} items`
        );
      }
    }
  );

  it('bounds media and attachments per part', () => {
    fc.assert(
      fc.property(
        anySchema,
        fc.integer({ min: 0, max: DROP_PART_MAX_MEDIA }),
        fc.integer({ min: 0, max: DROP_PART_MAX_ATTACHMENTS }),
        (schema, mediaCount, attachmentCount) => {
          const result = validate(schema, {
            parts: [
              {
                content: 'content',
                media: each(mediaCount, mediaItem),
                attachments: each(attachmentCount, attachment)
              }
            ]
          });
          expect(result.error).toBeUndefined();
        }
      ),
      RUNS
    );
    fc.assert(
      fc.property(
        anySchema,
        fc.integer({ min: 1, max: 30 }),
        (schema, extra) => {
          const tooMuchMedia = validate(schema, {
            parts: [
              {
                content: 'content',
                media: each(DROP_PART_MAX_MEDIA + extra, mediaItem)
              }
            ]
          });
          expect(tooMuchMedia.error?.message).toContain(
            `"parts[0].media" must contain less than or equal to ${DROP_PART_MAX_MEDIA} items`
          );
          const tooManyAttachments = validate(schema, {
            parts: [
              {
                content: 'content',
                attachments: each(DROP_PART_MAX_ATTACHMENTS + extra, attachment)
              }
            ]
          });
          expect(tooManyAttachments.error?.message).toContain(
            `"parts[0].attachments" must contain less than or equal to ${DROP_PART_MAX_ATTACHMENTS} items`
          );
        }
      ),
      RUNS
    );
  });

  describe.each(schemas)('%s totals across parts', (_name, schema) => {
    function spread<T>(
      total: number,
      perPart: number,
      field: 'media' | 'attachments',
      build: (index: number) => T
    ) {
      const parts: Array<Record<string, unknown>> = [];
      for (let used = 0; used < total; used += perPart) {
        const count = Math.min(perPart, total - used);
        parts.push({
          content: 'content',
          [field]: each(count, (index) => build(used + index))
        });
      }
      return parts;
    }

    it('caps media across all parts', () => {
      expect(
        validate(schema, {
          parts: spread(DROP_MAX_MEDIA, DROP_PART_MAX_MEDIA, 'media', mediaItem)
        }).error
      ).toBeUndefined();
      expect(
        validate(schema, {
          parts: spread(
            DROP_MAX_MEDIA + 1,
            DROP_PART_MAX_MEDIA,
            'media',
            mediaItem
          )
        }).error?.message
      ).toContain(
        `media across all drop parts must contain at most ${DROP_MAX_MEDIA} items in total`
      );
    });

    it('caps attachments across all parts', () => {
      expect(
        validate(schema, {
          parts: spread(
            DROP_MAX_ATTACHMENTS,
            DROP_PART_MAX_ATTACHMENTS,
            'attachments',
            attachment
          )
        }).error
      ).toBeUndefined();
      expect(
        validate(schema, {
          parts: spread(
            DROP_MAX_ATTACHMENTS + 1,
            DROP_PART_MAX_ATTACHMENTS,
            'attachments',
            attachment
          )
        }).error?.message
      ).toContain(
        `attachments across all drop parts must contain at most ${DROP_MAX_ATTACHMENTS} items in total`
      );
    });
  });

  const stringFields = [
    [
      'media url',
      DROP_MEDIA_URL_MAX_LENGTH,
      'parts[0].media[0].url',
      (value: string) => ({
        parts: [
          {
            content: 'content',
            media: [{ mime_type: 'image/png', url: value }]
          }
        ]
      })
    ],
    [
      'media mime_type',
      DROP_MEDIA_MIME_TYPE_MAX_LENGTH,
      'parts[0].media[0].mime_type',
      (value: string) => ({
        parts: [
          {
            content: 'content',
            media: [{ mime_type: value, url: 'https://example.com/a.png' }]
          }
        ]
      })
    ],
    [
      'media media_upload_id',
      DROP_MEDIA_UPLOAD_ID_MAX_LENGTH,
      'parts[0].media[0].media_upload_id',
      (value: string) => ({
        parts: [
          {
            content: 'content',
            media: [
              {
                mime_type: 'image/png',
                url: 'https://example.com/a.png',
                media_upload_id: value
              }
            ]
          }
        ]
      })
    ],
    [
      'attachment id',
      DROP_ATTACHMENT_ID_MAX_LENGTH,
      'parts[0].attachments[0].attachment_id',
      (value: string) => ({
        parts: [{ content: 'content', attachments: [{ attachment_id: value }] }]
      })
    ],
    [
      'referenced nft token',
      DROP_REFERENCED_NFT_TOKEN_MAX_LENGTH,
      'referenced_nfts[0].token',
      (value: string) => ({
        referenced_nfts: [
          {
            contract: `0x${'1'.repeat(40)}`,
            token: '1'.repeat(value.length),
            name: 'nft'
          }
        ]
      })
    ],
    [
      'referenced nft name',
      DROP_REFERENCED_NFT_NAME_MAX_LENGTH,
      'referenced_nfts[0].name',
      (value: string) => ({
        referenced_nfts: [
          { contract: `0x${'1'.repeat(40)}`, token: '1', name: value }
        ]
      })
    ],
    [
      'mentioned wave name',
      DROP_MENTIONED_WAVE_NAME_MAX_LENGTH,
      'mentioned_waves[0].wave_name_in_content',
      (value: string) => ({
        mentioned_waves: [{ wave_id: 'wave-2', wave_name_in_content: value }]
      })
    ]
  ] as const;

  it.each(stringFields)(
    'bounds %s to its column size (%s) on every drop schema',
    (_name, cap, path, build) => {
      fc.assert(
        fc.property(
          anySchema,
          fc.integer({ min: 1, max: cap }),
          (schema, length) => {
            expect(
              validate(schema, build('a'.repeat(length))).error
            ).toBeUndefined();
          }
        ),
        RUNS
      );
      fc.assert(
        fc.property(
          anySchema,
          fc.integer({ min: 1, max: 300 }),
          (schema, extra) => {
            expect(
              validate(schema, build('a'.repeat(cap + extra))).error?.message
            ).toContain(
              `"${path}" length must be less than or equal to ${cap} characters long`
            );
          }
        ),
        RUNS
      );
    }
  );

  it.each(schemas)(
    '%s still accepts null or omitted optional lists',
    (_name, schema) => {
      const withNulls = validate(schema, {
        referenced_nfts: null,
        mentioned_users: null
      });
      expect(withNulls.error).toBeUndefined();

      const { mentioned_waves, ...withoutWaves } = baseDrop(schema);
      expect(mentioned_waves).toEqual([]);
      expect(schema.validate(withoutWaves).error).toBeUndefined();
    }
  );

  it('does not echo oversized values back in the validation error', () => {
    const secret = 'media-url-that-must-not-appear-in-validation-errors';
    const result = validate(NewDropSchema, {
      parts: [
        {
          content: 'content',
          media: [
            {
              mime_type: 'image/png',
              url: `https://example.com/${'a'.repeat(DROP_MEDIA_URL_MAX_LENGTH)}${secret}`
            }
          ]
        }
      ]
    });
    expect(result.error?.message).toContain(
      `"parts[0].media[0].url" length must be less than or equal to ${DROP_MEDIA_URL_MAX_LENGTH} characters long`
    );
    expect(result.error?.message).not.toContain(secret);
  });
});
