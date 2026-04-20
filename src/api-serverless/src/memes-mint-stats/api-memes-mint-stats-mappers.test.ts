import type { ApiMemesMintStatRow } from '@/api/memes-mint-stats/api.memes-mint-stats.mappers';
import { rowToApiMemesMintStat } from '@/api/memes-mint-stats/api.memes-mint-stats.mappers';

function baseStat(
  overrides: Partial<ApiMemesMintStatRow> = {}
): ApiMemesMintStatRow {
  return {
    id: 484,
    mint_date: new Date('2024-01-01T00:00:00.000Z'),
    total_count: 328,
    mint_count: 308,
    subscriptions_count: 20,
    proceeds_eth: 12.34,
    proceeds_usd: 45678.9,
    artist_split_eth: 6.17,
    artist_split_usd: 22839.45,
    payment_details: null,
    ...overrides
  };
}

describe('rowToApiMemesMintStat', () => {
  it('maps payment details when present', () => {
    const stat = baseStat({
      payment_details: JSON.stringify({
        payment_address: '0x9c31993be9e616139a4f07092a3e1ff523a85f3c',
        has_designated_payee: false,
        designated_payee_name: ''
      })
    });

    expect(rowToApiMemesMintStat(stat).payment_details).toEqual({
      payment_address: '0x9c31993be9e616139a4f07092a3e1ff523a85f3c',
      has_designated_payee: false,
      designated_payee_name: ''
    });
  });

  it('returns null payment details when metadata is missing', () => {
    expect(rowToApiMemesMintStat(baseStat()).payment_details).toBeNull();
  });

  it('defaults missing payee fields when payment address is present', () => {
    const stat = baseStat({
      payment_details: '{"payment_address":"0xabc"}'
    });

    expect(rowToApiMemesMintStat(stat).payment_details).toEqual({
      payment_address: '0xabc',
      has_designated_payee: false,
      designated_payee_name: ''
    });
  });

  it('returns null payment details when payment address is missing', () => {
    const stat = baseStat({
      payment_details:
        '{"has_designated_payee":true,"designated_payee_name":"foo"}'
    });

    expect(rowToApiMemesMintStat(stat).payment_details).toBeNull();
  });

  it('passes through an already-parsed payment_details object', () => {
    const stat = baseStat({
      payment_details: {
        payment_address: '0xabc',
        has_designated_payee: false,
        designated_payee_name: ''
      }
    });

    expect(rowToApiMemesMintStat(stat).payment_details).toEqual({
      payment_address: '0xabc',
      has_designated_payee: false,
      designated_payee_name: ''
    });
  });
});
