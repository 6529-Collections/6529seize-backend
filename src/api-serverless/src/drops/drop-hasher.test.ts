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
