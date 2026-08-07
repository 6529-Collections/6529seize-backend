import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  DROP_PART_MAX_UTF16_CODE_UNITS,
  DROP_PART_MAX_UTF8_BYTES,
  DROP_TOTAL_MAX_UTF16_CODE_UNITS,
  NewDropSchema,
  NewWaveDropSchema,
  UpdateDropSchema
} from '@/api/drops/drop.validator';

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
