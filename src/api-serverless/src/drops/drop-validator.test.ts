import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { NewDropSchema } from '@/api/drops/drop.validator';

describe('NewDropSchema', () => {
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

  it('rejects metadata values over 5000 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('artist', 'a'.repeat(5001))
    );

    expect(result.error?.message).toContain(
      'metadata value for "artist" must be less than or equal to 5000 characters long'
    );
  });

  it('rejects metadata title values over 255 characters', () => {
    const result = NewDropSchema.validate(
      createDropWithMetadata('title', 'a'.repeat(256))
    );

    expect(result.error?.message).toContain(
      'metadata value for "title" must be less than or equal to 255 characters long'
    );
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
      '"metadata[0].data_value" length must be less than or equal to 8000 characters long'
    );
  });
});
