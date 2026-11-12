import { ApiXTdhCreateGrantSchema } from './xtdh-grants.validator';

const grant = (target_tokens: string[]) => ({
  target_chain: 'ETHEREUM_MAINNET',
  target_contract: '0x0000000000000000000000000000000000000001',
  target_tokens,
  rate: 1,
  is_irrevocable: false
});

const validate = (target_tokens: string[]) =>
  ApiXTdhCreateGrantSchema.validate(grant(target_tokens)).error?.message ??
  null;

describe('ApiXTdhCreateGrantSchema target tokens', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('accepts the whole collection, single tokens and ranges within the limits', () => {
    expect(validate([])).toBeNull();
    expect(validate(['1', '5-10', '12'])).toBeNull();
    expect(validate(['0-9999'])).toBeNull();
  });

  it('rejects a range wider than 10,000 tokens before expanding it', () => {
    expect(validate(['0-99999999999999'])).toBe(
      'Range "0-99999999999999" covers 100000000000000 tokens; a range can cover at most 10000.'
    );
  });

  it('rejects more than 10,000 tokens in total', () => {
    expect(validate(['0-9999', '10000'])).toContain(
      'A grant can target at most 10000 tokens'
    );
  });

  it('follows the configured limits', () => {
    process.env.XTDH_GRANT_MAX_TOKENS = '5';
    expect(validate(['1-5'])).toBeNull();
    expect(validate(['1-6'])).toContain('at most 5 tokens');
  });

  it('keeps the existing overlap validation', () => {
    expect(validate(['1-5', '3'])).not.toBeNull();
  });
});
