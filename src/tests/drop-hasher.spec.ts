import { DropHasher } from '../api-serverless/src/drops/drop-hasher';
import { ApiCreateDropRequest } from '../api-serverless/src/generated/models/ApiCreateDropRequest';

// js-sha256 is not installed in this environment; provide a simple mock
jest.mock('js-sha256', () => ({ sha256: (input: any) => JSON.stringify(input) }), {
  virtual: true
});

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
