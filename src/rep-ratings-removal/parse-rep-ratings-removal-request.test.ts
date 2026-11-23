import fc from 'fast-check';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MIN_TARGETS_PER_CATEGORY,
  isRepRatingsRemovalEvent,
  parseRepRatingsRemovalRequest,
  REP_RATINGS_REMOVE_JOB,
  RepRatingsRemovalMode,
  RepRatingsRemovalRefusal
} from './rep-ratings-removal.request';

const RATER = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    job: REP_RATINGS_REMOVE_JOB,
    mode: 'DRY_RUN',
    rater_profile_id: RATER,
    categories: ['Tag Alpha', 'Tag Beta'],
    ...overrides
  };
}

function refusal(overrides: Record<string, unknown>): string {
  try {
    parseRepRatingsRemovalRequest(payload(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(RepRatingsRemovalRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('parseRepRatingsRemovalRequest', () => {
  it('reads a dry run with the defaults', () => {
    expect(parseRepRatingsRemovalRequest(payload())).toEqual({
      mode: RepRatingsRemovalMode.DRY_RUN,
      rater: { profileId: RATER },
      categories: ['Tag Alpha', 'Tag Beta'],
      batchSize: DEFAULT_BATCH_SIZE,
      minTargetsPerCategory: DEFAULT_MIN_TARGETS_PER_CATEGORY,
      notAfterMillis: null,
      maxRatings: null
    });
  });

  it('reads every option of an apply run', () => {
    expect(
      parseRepRatingsRemovalRequest(
        payload({
          mode: 'APPLY',
          matter: 'REP',
          batch_size: 500,
          min_targets_per_category: 10,
          not_after: '2026-01-02T03:04:05Z',
          max_ratings: 1000
        })
      )
    ).toEqual({
      mode: RepRatingsRemovalMode.APPLY,
      rater: { profileId: RATER },
      categories: ['Tag Alpha', 'Tag Beta'],
      batchSize: 500,
      minTargetsPerCategory: 10,
      notAfterMillis: Date.parse('2026-01-02T03:04:05Z'),
      maxRatings: 1000
    });
  });

  it('keeps category names exactly, spaces and case included', () => {
    expect(
      parseRepRatingsRemovalRequest(
        payload({ categories: ['tag  alpha', 'Tag alpha ', 'TAG ALPHA'] })
      ).categories
    ).toEqual(['tag  alpha', 'Tag alpha ', 'TAG ALPHA']);
  });

  it('refuses a payload without a mode, so nothing applies by default', () => {
    expect(refusal({ mode: undefined })).toContain('mode must be');
    expect(refusal({ mode: 'apply' })).toContain('mode must be');
  });

  it('refuses unknown keys, so a misspelt option is never ignored', () => {
    expect(refusal({ dry_run: true })).toContain(
      'unknown payload keys: dry_run'
    );
  });

  it('refuses a matter other than REP', () => {
    expect(refusal({ matter: 'CIC' })).toContain('matter must be REP');
  });

  it('refuses a bad rater id', () => {
    expect(refusal({ rater_profile_id: '' })).toContain('rater_profile_id');
    expect(refusal({ rater_profile_id: ` ${RATER}` })).toContain(
      'rater_profile_id'
    );
    expect(refusal({ rater_profile_id: 'x'.repeat(51) })).toContain(
      'rater_profile_id'
    );
    expect(refusal({ rater_profile_id: 7 })).toContain('rater_profile_id');
  });

  it('refuses a bad category list', () => {
    expect(refusal({ categories: [] })).toContain('categories must be');
    expect(refusal({ categories: 'Tag Alpha' })).toContain(
      'categories must be'
    );
    expect(refusal({ categories: ['Tag Alpha', '  '] })).toContain(
      'categories[1]'
    );
    expect(refusal({ categories: ['x'.repeat(101)] })).toContain(
      'categories[0]'
    );
    expect(refusal({ categories: ['Tag Alpha', 'Tag Alpha'] })).toContain(
      'categories[1] is listed twice'
    );
  });

  it('takes the rater by handle instead, lowercased', () => {
    expect(
      parseRepRatingsRemovalRequest(
        payload({ rater_profile_id: undefined, rater_handle: 'Help6529' })
      ).rater
    ).toEqual({ handle: 'help6529' });
  });

  it('refuses both or neither rater field, and a bad handle', () => {
    expect(refusal({ rater_handle: 'help6529' })).toContain(
      'exactly one of rater_profile_id and rater_handle'
    );
    expect(refusal({ rater_profile_id: undefined })).toContain(
      'exactly one of rater_profile_id and rater_handle'
    );
    expect(
      refusal({ rater_profile_id: undefined, rater_handle: ' help6529' })
    ).toContain('rater_handle');
    expect(refusal({ rater_profile_id: undefined, rater_handle: 7 })).toContain(
      'rater_handle'
    );
  });

  it("accepts the help bot's credit category like any other", () => {
    expect(
      parseRepRatingsRemovalRequest(
        payload({ categories: ['Help6529 Credits'] })
      ).categories
    ).toEqual(['Help6529 Credits']);
  });

  it('refuses out-of-range numbers and a non-UTC time', () => {
    expect(refusal({ batch_size: 0 })).toContain('batch_size');
    expect(refusal({ batch_size: 5001 })).toContain('batch_size');
    expect(refusal({ batch_size: 1.5 })).toContain('batch_size');
    expect(refusal({ max_ratings: 0 })).toContain('max_ratings');
    expect(refusal({ min_targets_per_category: -1 })).toContain(
      'min_targets_per_category'
    );
    expect(refusal({ not_after: '2026-01-02T03:04:05+02:00' })).toContain(
      'not_after'
    );
    expect(refusal({ not_after: 'tomorrow' })).toContain('not_after');
  });

  it('refuses another job', () => {
    expect(() =>
      parseRepRatingsRemovalRequest({ ...payload(), job: 'OTHER' })
    ).toThrow(RepRatingsRemovalRefusal);
    expect(isRepRatingsRemovalEvent({ job: 'OTHER' })).toBe(false);
    expect(isRepRatingsRemovalEvent([])).toBe(false);
    expect(isRepRatingsRemovalEvent(null)).toBe(false);
    expect(isRepRatingsRemovalEvent(payload())).toBe(true);
  });

  it('reads any list of distinct category names back unchanged', () => {
    const name = fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((it) => it.trim().length > 0);
    fc.assert(
      fc.property(
        fc.uniqueArray(name, { minLength: 1, maxLength: 100 }),
        (categories) => {
          expect(
            parseRepRatingsRemovalRequest(payload({ categories })).categories
          ).toEqual(categories);
        }
      )
    );
  });

  it('refuses any key it does not know', () => {
    const known = new Set([
      'job',
      'mode',
      'rater_profile_id',
      'rater_handle',
      'matter',
      'categories',
      'batch_size',
      'min_targets_per_category',
      'not_after',
      'max_ratings'
    ]);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((it) => !known.has(it)),
        (key) => {
          expect(() =>
            parseRepRatingsRemovalRequest({ ...payload(), [key]: 1 })
          ).toThrow('unknown payload keys');
        }
      )
    );
  });
});
