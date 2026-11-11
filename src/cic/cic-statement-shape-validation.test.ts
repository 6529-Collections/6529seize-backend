import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';
import {
  CIC_STATEMENT_TYPES_BY_GROUP,
  MAX_CIC_STATEMENT_COMMENT_LENGTH,
  MAX_CIC_STATEMENTS_PER_PROFILE,
  validateCicStatementCount,
  validateCicStatementShape
} from './cic-statement-validation';

const statement = (
  overrides: Partial<CicStatement> = {}
): Omit<CicStatement, 'id' | 'crated_at'> => ({
  profile_id: 'profile-id',
  statement_group: CicStatementGroup.CONTACT,
  statement_type: 'EMAIL',
  statement_comment: null,
  statement_value: 'someone@example.com',
  ...overrides
});

const existing = (index: number): CicStatement => ({
  id: `statement-${index}`,
  crated_at: new Date(0),
  ...statement({ statement_value: `user${index}@example.com` })
});

const URL_GROUPS = new Set([
  CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
  CicStatementGroup.NFT_ACCOUNTS,
  CicStatementGroup.SOCIAL_MEDIA_VERIFICATION_POST
]);

describe('validateCicStatementShape', () => {
  const offeredTypes = Object.entries(CIC_STATEMENT_TYPES_BY_GROUP).flatMap(
    ([group, types]) => types.map((type) => [group, type] as const)
  );

  it.each(offeredTypes)('accepts %s / %s', (group, type) => {
    const needsUrl =
      URL_GROUPS.has(group as CicStatementGroup) ||
      type === 'WEBSITE' ||
      type === 'LINK';
    expect(() =>
      validateCicStatementShape(
        statement({
          statement_group: group as CicStatementGroup,
          statement_type: type,
          statement_value: needsUrl ? 'https://example.com/me' : 'value'
        })
      )
    ).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() =>
      validateCicStatementShape(
        statement({ statement_type: 'FUTURE_PLATFORM' })
      )
    ).toThrow(
      'Statement type FUTURE_PLATFORM is not supported for group CONTACT'
    );
  });

  it('rejects a type offered only for another group', () => {
    expect(() =>
      validateCicStatementShape(
        statement({
          statement_group: CicStatementGroup.GENERAL,
          statement_type: 'X',
          statement_value: 'https://x.com/someone'
        })
      )
    ).toThrow('is not supported for group GENERAL');
  });

  it.each([
    [CicStatementGroup.SOCIAL_MEDIA_ACCOUNT, 'LINKTREE', 'linktr.ee/me'],
    [CicStatementGroup.SOCIAL_MEDIA_VERIFICATION_POST, 'LINK', 'javascript:x'],
    [CicStatementGroup.CONTACT, 'WEBSITE', 'data:text/html,x'],
    [CicStatementGroup.CONTACT, 'WEBSITE', 'ftp://example.com'],
    [CicStatementGroup.NFT_ACCOUNTS, 'LINK', 'https://user:pass@example.com']
  ])('requires an http(s) URL for %s / %s, not %s', (group, type, value) => {
    expect(() =>
      validateCicStatementShape(
        statement({
          statement_group: group,
          statement_type: type,
          statement_value: value
        })
      )
    ).toThrow('must be an http or https URL');
  });

  it('caps the comment length', () => {
    expect(() =>
      validateCicStatementShape(
        statement({
          statement_comment: 'x'.repeat(MAX_CIC_STATEMENT_COMMENT_LENGTH)
        })
      )
    ).not.toThrow();
    expect(() =>
      validateCicStatementShape(
        statement({
          statement_comment: 'x'.repeat(MAX_CIC_STATEMENT_COMMENT_LENGTH + 1)
        })
      )
    ).toThrow(`longer than ${MAX_CIC_STATEMENT_COMMENT_LENGTH}`);
  });
});

describe('validateCicStatementCount', () => {
  const full = Array.from(
    { length: MAX_CIC_STATEMENTS_PER_PROFILE },
    (_, index) => existing(index)
  );

  it('accepts a statement below the cap', () => {
    expect(() =>
      validateCicStatementCount(statement(), full.slice(1))
    ).not.toThrow();
  });

  it('rejects a statement at the cap', () => {
    expect(() => validateCicStatementCount(statement(), full)).toThrow(
      `at most ${MAX_CIC_STATEMENTS_PER_PROFILE} statements`
    );
  });

  it('always accepts a bio, which replaces the current bio', () => {
    expect(() =>
      validateCicStatementCount(
        statement({
          statement_group: CicStatementGroup.GENERAL,
          statement_type: 'BIO'
        }),
        full
      )
    ).not.toThrow();
  });
});
