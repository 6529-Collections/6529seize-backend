import { scanTableConstants } from '@/rebuild/table-discovery';

describe('scanTableConstants', () => {
  const source = `
export const NFTS_TABLE = 'nfts';
export const WALLET_TRANSFER_ANALYSIS_STATES_TABLE =
  'wallet_transfer_analysis_states';
export const PROFILE_GROUP_CHANGES = "profile_group_changes";
export const XTDH_TOKEN_STATS_TABLE_PREFIX = 'xtdh_token_stats_';
export const MEMES_CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
const PRIVATE_TABLE = 'private_table';
export const TEMPLATE_TABLE = \`\${PREFIX}a\`;
`;

  it('takes every string export of the table constants file except prefixes', () => {
    expect(scanTableConstants(source, true)).toEqual([
      'nfts',
      'wallet_transfer_analysis_states',
      'profile_group_changes'
    ]);
  });

  it('takes only *_TABLE exports elsewhere', () => {
    expect(scanTableConstants(source, false)).toEqual([
      'nfts',
      'wallet_transfer_analysis_states'
    ]);
  });
});
