import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';
import {
  MAX_NFT_ACCOUNT_STATEMENTS,
  prepareCicStatementForInsert,
  validateNftAccountStatementConstraints
} from './cic-statement-validation';

const nftStatement = (
  overrides: Partial<CicStatement> = {}
): Omit<CicStatement, 'id' | 'crated_at'> => ({
  profile_id: 'profile-id',
  statement_group: CicStatementGroup.NFT_ACCOUNTS,
  statement_type: 'NINFA',
  statement_comment: null,
  statement_value: 'https://ninfa.io/user/%40artist',
  ...overrides
});

const existingNftStatement = (
  overrides: Partial<CicStatement> = {}
): CicStatement => ({
  id: 'statement-id',
  crated_at: new Date(0),
  ...nftStatement(overrides)
});

describe('CIC statement validation', () => {
  it.each([
    'https://ninfa.io/user/%40artist',
    'https://artist.ninfa.io/browse'
  ])('accepts a secure Ninfa URL at %s', (statementValue) => {
    expect(
      prepareCicStatementForInsert(
        nftStatement({ statement_value: statementValue })
      )
    ).toMatchObject({
      statement_comment: null,
      statement_value: statementValue
    });
  });

  it.each([
    'http://ninfa.io/user/artist',
    'https://ninfa.io.evil.example/user/artist',
    'https://user:secret@ninfa.io/user/artist',
    'javascript:alert(1)'
  ])('rejects an unsafe Ninfa URL at %s', (statementValue) => {
    expect(() =>
      prepareCicStatementForInsert(
        nftStatement({ statement_value: statementValue })
      )
    ).toThrow();
  });

  it('normalizes a custom art link label and URL', () => {
    expect(
      prepareCicStatementForInsert(
        nftStatement({
          statement_type: 'LINK',
          statement_comment: '  AOTM  ',
          statement_value: 'https://EXAMPLE.art'
        })
      )
    ).toMatchObject({
      statement_comment: 'AOTM',
      statement_value: 'https://example.art/'
    });
  });

  it.each([null, '   ', '<b>AOTM</b>', 'Ninfa', 'A\u202eOTM'])(
    'rejects invalid custom art link label %p',
    (statementComment) => {
      expect(() =>
        prepareCicStatementForInsert(
          nftStatement({
            statement_type: 'LINK',
            statement_comment: statementComment,
            statement_value: 'https://example.art/artist'
          })
        )
      ).toThrow();
    }
  );

  it('requires every new NFT account statement to use a secure URL', () => {
    expect(() =>
      prepareCicStatementForInsert(
        nftStatement({
          statement_type: 'FUTURE_PLATFORM',
          statement_value: 'data:text/html,unsafe'
        })
      )
    ).toThrow('NFT account URL must use HTTPS');
  });

  it('rejects normalized duplicate NFT account URLs across statement types', () => {
    const statement = prepareCicStatementForInsert(
      nftStatement({
        statement_type: 'LINK',
        statement_comment: 'AOTM',
        statement_value: 'https://example.art/#portfolio'
      })
    );
    expect(() =>
      validateNftAccountStatementConstraints(statement, [
        existingNftStatement({
          statement_type: 'FUTURE_PLATFORM',
          statement_value: 'https://EXAMPLE.art/'
        })
      ])
    ).toThrow('already on the profile');
  });

  it('rejects NFT account links above the profile limit', () => {
    const existingStatements = Array.from(
      { length: MAX_NFT_ACCOUNT_STATEMENTS },
      (_, index) =>
        existingNftStatement({
          id: `statement-${index}`,
          statement_value: `https://artist-${index}.example/`
        })
    );
    expect(() =>
      validateNftAccountStatementConstraints(
        nftStatement({ statement_value: 'https://new-artist.example/' }),
        existingStatements
      )
    ).toThrow(`at most ${MAX_NFT_ACCOUNT_STATEMENTS}`);
  });

  it('leaves non-NFT statements unchanged', () => {
    const statement = nftStatement({
      statement_group: CicStatementGroup.CONTACT,
      statement_type: 'WEBSITE',
      statement_value: 'http://example.com'
    });
    expect(prepareCicStatementForInsert(statement)).toBe(statement);
  });
});
