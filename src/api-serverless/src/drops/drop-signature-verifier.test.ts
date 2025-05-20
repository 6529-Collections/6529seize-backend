jest.mock('js-sha256', () => ({ sha256: jest.fn(() => 'hash') }), { virtual: true });

import { DropSignatureVerifier } from './drop-signature-verifier';
import { DropHasher } from './drop-hasher';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';

describe('DropSigntureVerifier', () => {
  let dropHasher: DropHasher;
  let dropSignatureVerifier: DropSignatureVerifier;

  beforeEach(() => {
    dropHasher = mock();
    dropSignatureVerifier = new DropSignatureVerifier(dropHasher);
  });

  const aDrop = {
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
    metadata: []
  };
  const signer = '0xcbDC531bd9A56126d79D1A52a318Cd5e55C0356d';
  const aCorrectSignature =
    '0xfff364548ccd40ad3e8d0acdead58a35f5738a805c7e497c71a82094ee1972a84f10b55652bbc7d887368ed6f1a88c943c57acb276c2fa343cb4d6bb6bb725191b';
  const aDropsHash = 'aDropsHash';

  it('correctly signed drop with no wallets returns false', () => {
    when(dropHasher.hash).mockReturnValue(aDropsHash);
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
        drop: { ...aDrop, signature: aCorrectSignature },
        termsOfService: 'TOS',
        wallets: []
      })
    ).toBe(false);
  });

  it('correctly signed drop with signer not in wallets returns false', () => {
    when(dropHasher.hash).mockReturnValue(aDropsHash);
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
        drop: { ...aDrop, signature: aCorrectSignature },
        termsOfService: 'TOS',
        wallets: ['0xNotASigner']
      })
    ).toBe(false);
  });

  it('drop with nonsense signature returns false', () => {
    when(dropHasher.hash).mockReturnValue(aDropsHash);
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
        drop: { ...aDrop, signature: 'nonsense' },
        termsOfService: 'TOS',
        wallets: [signer]
      })
    ).toBe(false);
  });

  it('incorrectly signed drop with correct signer in wallets returns false', () => {
    when(dropHasher.hash).mockReturnValue(aDropsHash);
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
        drop: {
          ...aDrop,
          signature:
            '0xe382835e60050c303ff5499b44fdb1ec053f84604fc279e46a668f4a71393d004a95cb4acbec2be37f2d3bdb2d9a17c9fc8e1bbbfe6ebbb082a892afa2292b3d1b'
        },
        termsOfService: 'TOS',
        wallets: [signer]
      })
    ).toBe(false);
  });

  it('correctly signed drop with signer in wallets returns true', () => {
    when(dropHasher.hash).mockReturnValue(aDropsHash);
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
        drop: { ...aDrop, signature: aCorrectSignature },
        termsOfService: 'TOS',
        wallets: [signer]
      })
    ).toBe(true);
  });
});
