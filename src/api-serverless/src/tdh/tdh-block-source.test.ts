import { blockSource } from './tdh-block-source';

describe('blockSource', () => {
  it('says SITE for a block the site computed', () => {
    expect(
      blockSource({ chain_cycle_day: null, chain_wallet_root: null })
    ).toEqual({
      source: 'SITE'
    });
  });

  it('says CHAIN with the day and root for a block the chain wrote', () => {
    expect(
      blockSource({
        chain_cycle_day: 20782,
        chain_wallet_root: `0x${'a'.repeat(64)}`
      })
    ).toEqual({
      source: 'CHAIN',
      cycle_day: 20782,
      wallet_root: `0x${'a'.repeat(64)}`
    });
  });
});
