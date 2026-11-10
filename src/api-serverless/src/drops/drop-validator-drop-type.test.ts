import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { NewDropSchema } from '@/api/drops/drop.validator';

/**
 * Request fixtures for the `drop_type` contract of POST /drops. The OpenAPI
 * schema documents the field as optional with a CHAT default; these fixtures
 * pin the runtime (Joi) behaviour the schema describes.
 */
function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    wave_id: 'wave-1',
    title: null,
    parts: [{ content: 'hello', media: [], attachments: [] }],
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_waves: [],
    metadata: [],
    signature: null,
    ...overrides
  };
}

describe('NewDropSchema drop_type', () => {
  it('defaults an omitted drop_type to CHAT', () => {
    const { error, value } = NewDropSchema.validate(chatBody());
    expect(error).toBeUndefined();
    expect(value.drop_type).toBe(ApiDropType.Chat);
  });

  it('keeps an explicit CHAT drop_type', () => {
    const { error, value } = NewDropSchema.validate(
      chatBody({ drop_type: ApiDropType.Chat })
    );
    expect(error).toBeUndefined();
    expect(value.drop_type).toBe(ApiDropType.Chat);
  });

  it('keeps an explicit PARTICIPATORY drop_type', () => {
    const { error, value } = NewDropSchema.validate(
      chatBody({ drop_type: ApiDropType.Participatory })
    );
    expect(error).toBeUndefined();
    expect(value.drop_type).toBe(ApiDropType.Participatory);
  });

  it('rejects WINNER, which only the backend assigns', () => {
    const { error } = NewDropSchema.validate(
      chatBody({ drop_type: ApiDropType.Winner })
    );
    expect(error?.message).toMatch(/drop_type/);
  });

  it('rejects an unknown drop_type value', () => {
    const { error } = NewDropSchema.validate(chatBody({ drop_type: 'chat' }));
    expect(error?.message).toMatch(/drop_type/);
  });

  it('does not accept a legacy `type` field in place of drop_type', () => {
    const { error } = NewDropSchema.validate(
      chatBody({ type: ApiDropType.Participatory })
    );
    expect(error?.message).toMatch(/"type" is not allowed/);
  });
});
