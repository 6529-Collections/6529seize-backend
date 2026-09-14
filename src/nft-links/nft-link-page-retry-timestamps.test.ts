import { validateLinkUrl } from './nft-link-resolver.validator';
import {
  isNftLinkRefreshDue,
  nextNftPageRetryState,
  nftPageRetryScope,
  readNftPageRetryState
} from './nft-link-page-retry';

const canonical = validateLinkUrl(
  'https://transient.xyz/mint/timestamp-fixture'
);
const scope = nftPageRetryScope(canonical);
const now = 1_800_000_000_000;
const empty = {
  last_tried_to_update: 0,
  last_successfully_updated: null,
  failed_since: null
};
const state = nextNftPageRetryState(empty, scope, now, 1);
const row = {
  last_tried_to_update: String(now),
  last_successfully_updated: '1',
  failed_since: String(now),
  refresh_retry_state: state
};

it.each([0, now])(
  'uses arithmetic for numeric and driver-string attempt %s',
  (attempt) => {
    for (const timestamp of [attempt, String(attempt)]) {
      const value = { ...empty, last_tried_to_update: timestamp };
      expect(
        isNftLinkRefreshDue(value, canonical, attempt + 120_000, 120_000)
      ).toBe(false);
      expect(
        isNftLinkRefreshDue(value, canonical, attempt + 120_001, 120_000)
      ).toBe(true);
    }
  }
);

it('recognizes all string timestamps, keeps the cooldown boundary and advances streak', () => {
  expect(readNftPageRetryState(row, scope)).toEqual(state);
  expect(
    isNftLinkRefreshDue(row, canonical, state.notBefore - 1, 120_000)
  ).toBe(false);
  expect(isNftLinkRefreshDue(row, canonical, state.notBefore, 120_000)).toBe(
    true
  );
  expect(nextNftPageRetryState(row, scope, state.notBefore, 1).streak).toBe(2);
  expect(
    readNftPageRetryState(
      { ...row, last_successfully_updated: String(now) },
      scope
    )
  ).toBeNull();
  expect(
    readNftPageRetryState(
      { ...row, last_tried_to_update: String(now + 1) },
      scope
    )
  ).toBeNull();
});

it.each([
  '',
  ' ',
  '1e3',
  '-1',
  '1.5',
  '1700000000000junk',
  '9007199254740992',
  Number.NaN,
  Number.POSITIVE_INFINITY
])('does not accept malformed or unsafe persisted timestamp %s', (value) => {
  expect(
    readNftPageRetryState({ ...row, last_tried_to_update: value }, scope)
  ).toBeNull();
  expect(
    readNftPageRetryState({ ...row, failed_since: value }, scope)
  ).toBeNull();
  expect(
    readNftPageRetryState({ ...row, last_successfully_updated: value }, scope)
  ).toBeNull();
  expect(
    isNftLinkRefreshDue(
      { ...row, last_tried_to_update: value },
      canonical,
      state.notBefore,
      120_000
    )
  ).toBe(true);
  expect(
    nextNftPageRetryState(
      { ...row, failed_since: value },
      scope,
      state.notBefore,
      1
    ).streak
  ).toBe(1);
});
