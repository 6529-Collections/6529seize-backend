import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { NewDropSchema } from '@/api/drops/drop.validator';

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

  it('accepts hidden link previews on create requests', () => {
    const result = NewDropSchema.validate({
      ...createDropWithMetadata('artist', 'Artist'),
      drop_type: ApiDropType.Chat,
      hide_link_preview: true
    });

    expect(result.error).toBeUndefined();
    expect(result.value.hide_link_preview).toBe(true);
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
