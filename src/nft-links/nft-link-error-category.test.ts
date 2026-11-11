import { FetchError } from 'node-fetch';
import {
  PublicFetchTimeoutError,
  PublicNetworkPolicyError,
  PublicResponseTooLargeError
} from '@/http/public-fetch';
import { HttpError, NftLinkHttpTimeoutError } from '@/nft-links/lib/http';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';
import { NftLinkResolutionDeadlineError } from '@/nft-links/resolution-budget';
import {
  categorizeNftLinkError,
  NFT_LINK_ERROR_CATEGORIES,
  toPublicNftLinkErrorMessage
} from './nft-link-error-category';
import { mapNftLinkEntityToApiLink } from './nft-link-api.mapper';
import type { NftLinkEntity } from '@/entities/INftLink';

describe('categorizeNftLinkError', () => {
  it.each([
    [new NftLinkHttpTimeoutError(), 'TIMEOUT'],
    [new NftLinkResolutionDeadlineError(), 'TIMEOUT'],
    [new PublicFetchTimeoutError(5000), 'TIMEOUT'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'TIMEOUT'],
    [new NftLinkResolverValidationError('unsupported link'), 'UNSUPPORTED'],
    [new SyntaxError('Unexpected token < in JSON'), 'INVALID_METADATA'],
    [new HttpError(404, 'https://example.com/a', 'HTTP 404'), 'FETCH_FAILED'],
    [
      new FetchError('connect ECONNREFUSED 10.0.0.1:80', 'system'),
      'FETCH_FAILED'
    ],
    [new PublicNetworkPolicyError('Blocked host'), 'FETCH_FAILED'],
    [new PublicResponseTooLargeError(10, 20, 'stream'), 'FETCH_FAILED'],
    [new Error('execution reverted: internal detail'), 'RESOLUTION_FAILED'],
    ['a string', 'RESOLUTION_FAILED'],
    [undefined, 'RESOLUTION_FAILED']
  ])('maps %p to %s', (error, expected) => {
    expect(categorizeNftLinkError(error)).toBe(expected);
  });
});

describe('toPublicNftLinkErrorMessage', () => {
  it('passes stored categories through', () => {
    for (const category of NFT_LINK_ERROR_CATEGORIES) {
      expect(toPublicNftLinkErrorMessage(category)).toBe(category);
    }
  });

  it('never returns legacy free text', () => {
    expect(
      toPublicNftLinkErrorMessage(
        'connect ECONNREFUSED 10.0.0.1:80 http://internal.example/secret'
      )
    ).toBe('RESOLUTION_FAILED');
    expect(toPublicNftLinkErrorMessage(null)).toBeNull();
  });

  it('is applied by the API mapper', () => {
    const mapped = mapNftLinkEntityToApiLink({
      canonical_id: 'x',
      last_error_message: 'HTTP 500 for https://example.com/private?token=1',
      full_data: null
    } as unknown as NftLinkEntity);
    expect(mapped.last_error_message).toBe('RESOLUTION_FAILED');
  });
});
