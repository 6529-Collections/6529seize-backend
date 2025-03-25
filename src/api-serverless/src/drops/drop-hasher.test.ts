import { DropHasher } from './drop-hasher';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';

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
});
