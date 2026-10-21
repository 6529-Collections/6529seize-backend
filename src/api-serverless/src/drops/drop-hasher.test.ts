import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { DropHasher } from '@/api/drops/drop-hasher';

describe('DropHasher', () => {
  const dropHasher = new DropHasher();

  const aDrop: ApiCreateDropRequest = {
    wave_id: '123',
    title: 'Hello test',
    parts: [
      {
        content: 'Hello world',
        media: []
      }
    ],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    signature: null
  };

  it('distinguishes absent, empty and populated collaborator lists in the signed payload', () => {
    const hash = (drop: ApiCreateDropRequest) =>
      dropHasher.hash({ drop, termsOfService: null });
    const original = hash(aDrop);
    expect(hash({ ...aDrop, collaborator_ids: undefined })).toBe(original);
    const managed = hash({ ...aDrop, collaborator_ids: [] });
    expect(managed).not.toBe(original);
    expect(hash({ ...aDrop, collaborator_ids: ['B', 'C'] })).not.toBe(managed);
    expect(hash({ ...aDrop, collaborator_ids: ['B', 'C'] })).not.toBe(
      hash({ ...aDrop, collaborator_ids: ['B'] })
    );
  });

  it('TOS affects the hash', () => {
    expect(
      dropHasher.hash({
        drop: aDrop,
        termsOfService: null
      })
    ).not.toBe(
      dropHasher.hash({
        drop: aDrop,
        termsOfService: 'I hereby agree to stuff'
      })
    );
  });

  it('signature doesnt affect the hash', () => {
    expect(
      dropHasher.hash({
        drop: aDrop,
        termsOfService: null
      })
    ).toBe(
      dropHasher.hash({
        drop: { ...aDrop, signature: 'some_signature' },
        termsOfService: null
      })
    );
  });

  it('hide link preview affects the hash when present', () => {
    expect(
      dropHasher.hash({
        drop: aDrop,
        termsOfService: null
      })
    ).not.toBe(
      dropHasher.hash({
        drop: { ...aDrop, hide_link_preview: true },
        termsOfService: null
      })
    );
  });

  it('ignores undefined hide link preview but hashes explicit false', () => {
    const baseHash = dropHasher.hash({
      drop: aDrop,
      termsOfService: null
    });

    expect(
      dropHasher.hash({
        drop: { ...aDrop, hide_link_preview: undefined },
        termsOfService: null
      })
    ).toBe(baseHash);
    expect(
      dropHasher.hash({
        drop: { ...aDrop, hide_link_preview: false },
        termsOfService: null
      })
    ).not.toBe(baseHash);
  });
});
