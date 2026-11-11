import {
  DELEGATIONS_TABLE,
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_AIRDROPS,
  USE_CASE_MINTING
} from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import { fetchProcessedDelegations } from './db.delegations';

const COLD = '0xc01d000000000000000000000000000000000c01';
const OTHER_COLD = '0xc02d000000000000000000000000000000000c02';
const BLANKET_HOT = '0x1111111111111111111111111111111111111111';
const TOKEN_HOT = '0x2222222222222222222222222222222222222222';

function delegation(overrides: Record<string, unknown>) {
  return {
    block: 10,
    from_address: COLD,
    to_address: BLANKET_HOT,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 0,
    ...overrides
  };
}

describeWithSeed(
  'fetchProcessedDelegations token scope',
  [
    {
      table: DELEGATIONS_TABLE,
      rows: [
        delegation({ block: 10, to_address: BLANKET_HOT }),
        delegation({
          block: 5,
          to_address: BLANKET_HOT,
          use_case: USE_CASE_AIRDROPS
        }),
        delegation({
          block: 20,
          to_address: TOKEN_HOT,
          all_tokens: false,
          token_id: 61
        }),
        delegation({
          block: 30,
          from_address: OTHER_COLD,
          to_address: TOKEN_HOT,
          all_tokens: false,
          token_id: 61
        }),
        delegation({
          block: 40,
          to_address: TOKEN_HOT,
          use_case: USE_CASE_AIRDROPS,
          all_tokens: false,
          token_id: 61
        })
      ]
    }
  ],
  () => {
    function mapping(rows: { from_address: string; to_address: string }[]) {
      return Object.fromEntries(
        rows.map((it) => [it.from_address, it.to_address])
      );
    }

    it('applies only delegations for all tokens without a token', async () => {
      const rows = await fetchProcessedDelegations(
        MEMES_CONTRACT,
        USE_CASE_MINTING
      );
      expect(mapping(rows)).toEqual({ [COLD]: BLANKET_HOT });
    });

    it('applies a delegation for the token in question', async () => {
      const rows = await fetchProcessedDelegations(
        MEMES_CONTRACT,
        USE_CASE_MINTING,
        undefined,
        61
      );
      expect(mapping(rows)).toEqual({
        [COLD]: TOKEN_HOT,
        [OTHER_COLD]: TOKEN_HOT
      });
    });

    it('ignores a delegation for another token', async () => {
      const rows = await fetchProcessedDelegations(
        MEMES_CONTRACT,
        USE_CASE_MINTING,
        undefined,
        62
      );
      expect(mapping(rows)).toEqual({ [COLD]: BLANKET_HOT });
    });

    it('keeps the all-tokens airdrop address over a token-specific one', async () => {
      const rows = await fetchProcessedDelegations(
        MEMES_CONTRACT,
        USE_CASE_AIRDROPS,
        [COLD]
      );
      expect(mapping(rows)).toEqual({ [COLD]: BLANKET_HOT });
    });
  }
);
