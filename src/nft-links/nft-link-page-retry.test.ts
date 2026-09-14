import { validateLinkUrl } from './nft-link-resolver.validator';
import { HttpError } from './lib/http';
import {
  isNftLinkRefreshDue,
  nextNftPageRetryState,
  nftPageRetryScope,
  readNftPageRetryState,
  requiredNftPage404
} from './nft-link-page-retry';
import { mapNftLinkEntityToApiLink } from './nft-link-api.mapper';
import type { NftLinkEntity } from '@/entities/INftLink';

const canonical = validateLinkUrl(
  'https://transient.xyz/mint/synthetic-fixture'
);
const scope = nftPageRetryScope(canonical);
const now = 1_800_000_000_000;
const empty = {
  last_tried_to_update: 0,
  last_successfully_updated: null,
  failed_since: null
};
const state = nextNftPageRetryState(empty, scope, now, 1);
const failed = {
  ...empty,
  last_tried_to_update: now,
  failed_since: now,
  refresh_retry_state: state
};

describe('persistent required-page 404 eligibility', () => {
  it('keeps production-generated jitter inside the persisted policy bounds', () => {
    let row = failed;
    for (const minutes of [15, 60, 60]) {
      const attemptedAt = row.refresh_retry_state.notBefore + 1;
      const next = nextNftPageRetryState(row, scope, attemptedAt);
      expect(next.notBefore - attemptedAt).toBeGreaterThanOrEqual(
        minutes * 60_000 * 0.9
      );
      expect(next.notBefore - attemptedAt).toBeLessThanOrEqual(
        minutes * 60_000
      );
      row = {
        ...row,
        last_tried_to_update: attemptedAt,
        refresh_retry_state: next
      };
      expect(readNftPageRetryState(row, scope)).toEqual(next);
    }
  });

  it('advances eligible runs through 5, 15 and capped 60 minutes with bounded jitter', () => {
    let row = failed;
    expect(state.notBefore - now).toBe(300_000);
    for (const minutes of [15, 60, 60, 60]) {
      const attemptedAt = row.refresh_retry_state.notBefore + 1;
      const next = nextNftPageRetryState(row, scope, attemptedAt, 0);
      expect(next.notBefore - attemptedAt).toBe(minutes * 60_000 * 0.9);
      row = {
        ...row,
        last_tried_to_update: attemptedAt,
        refresh_retry_state: next
      };
    }
    expect(row.refresh_retry_state.streak).toBe(3);
  });

  it('is due at the persisted boundary and remains eligible indefinitely on future demand', () => {
    expect(
      isNftLinkRefreshDue(failed, canonical, state.notBefore - 1, 120_000)
    ).toBe(false);
    expect(
      isNftLinkRefreshDue(failed, canonical, state.notBefore, 120_000)
    ).toBe(true);
    expect(
      isNftLinkRefreshDue(failed, canonical, now + 99 * 86_400_000, 120_000)
    ).toBe(true);
  });

  it('shares policy for normalized tracking aliases but not a changed canonical page', () => {
    const alias = validateLinkUrl(canonical.viewUrl + '?utm_source=fixture');
    expect(nftPageRetryScope(alias)).toBe(scope);
    expect(isNftLinkRefreshDue(failed, alias, now + 130_000, 120_000)).toBe(
      false
    );
    const changed = {
      ...canonical,
      viewUrl: canonical.viewUrl + '/different-page'
    };
    expect(isNftLinkRefreshDue(failed, changed, now + 130_000, 120_000)).toBe(
      true
    );
    expect(
      nextNftPageRetryState(
        failed,
        nftPageRetryScope(changed),
        now + 130_000,
        1
      ).streak
    ).toBe(1);
  });

  it.each([
    null,
    '{broken',
    { ...state, version: 2 },
    { ...state, code: 'HTTP_500' },
    { ...state, streak: 0 },
    { ...state, streak: 99 },
    { ...state, notBefore: now + 86_400_000 },
    { ...state, attemptedAt: now - 1 },
    { ...state, scopeHash: 'unknown' }
  ])(
    'falls back to ordinary refresh for malformed, incompatible or obsolete state %j',
    (value) => {
      const row = { ...failed, refresh_retry_state: value };
      expect(isNftLinkRefreshDue(row, canonical, now + 130_000, 120_000)).toBe(
        true
      );
      expect(isNftLinkRefreshDue(row, canonical, now + 120_000, 120_000)).toBe(
        false
      );
    }
  );

  it('reads database JSON strings and invalidates an old writer attempt or successful reset', () => {
    expect(
      readNftPageRetryState(
        { ...failed, refresh_retry_state: JSON.stringify(state) },
        scope
      )
    ).toEqual(state);
    for (const row of [
      { ...failed, last_tried_to_update: now + 1 },
      { ...failed, failed_since: null },
      { ...failed, last_successfully_updated: now }
    ]) {
      expect(readNftPageRetryState(row, scope)).toBeNull();
      expect(nextNftPageRetryState(row, scope, now + 1, 1).streak).toBe(1);
    }
  });

  it('keeps internal retry metadata out of the public mapper while retaining cached output', () => {
    const row = {
      ...failed,
      canonical_id: canonical.canonicalId,
      full_data: { asset: { title: 'Cached title' } },
      media_uri: 'https://example.com/cached.png'
    } as NftLinkEntity;
    const mapped = mapNftLinkEntityToApiLink(row);
    expect(mapped).toMatchObject({
      name: 'Cached title',
      media_uri: row.media_uri,
      failed_since: now
    });
    expect(JSON.stringify(mapped)).not.toContain(scope);
    expect(mapped).not.toHaveProperty('refresh_retry_state');
  });
});

describe('typed page failure provenance', () => {
  it('accepts only the exact required page 404 with known final response URL', () => {
    const redirected = new HttpError(
      404,
      canonical.viewUrl,
      'synthetic',
      'https://example.com/private-redirect-marker'
    );
    expect(redirected.responseMatchesRequest).toBe(false);
    expect(JSON.stringify(redirected)).not.toContain('private-redirect-marker');
    expect(redirected).not.toHaveProperty('responseUrl');
    const result = requiredNftPage404(
      new HttpError(404, canonical.viewUrl, 'synthetic', canonical.viewUrl),
      canonical
    );
    expect(result?.scopeHash).toBe(scope);
    expect(result?.message).not.toContain(canonical.viewUrl);
  });
  it.each([
    new Error('HTTP 404'),
    new HttpError(404, canonical.viewUrl, 'synthetic'),
    new HttpError(429, canonical.viewUrl, 'synthetic', canonical.viewUrl),
    new HttpError(500, canonical.viewUrl, 'synthetic', canonical.viewUrl),
    new HttpError(
      404,
      'https://example.com/asset.json',
      'synthetic',
      canonical.viewUrl
    ),
    new HttpError(
      404,
      canonical.viewUrl,
      'synthetic',
      'https://example.com/redirect'
    )
  ])(
    'does not classify a generic/transient/asset/redirect failure',
    (error) => {
      expect(requiredNftPage404(error, canonical)).toBeNull();
    }
  );
  it('leaves SuperRare and unrelated adapters out of this policy', () => {
    expect(
      requiredNftPage404(
        new HttpError(404, canonical.viewUrl, 'synthetic', canonical.viewUrl),
        { ...canonical, platform: 'SUPERRARE' }
      )
    ).toBeNull();
  });
});
