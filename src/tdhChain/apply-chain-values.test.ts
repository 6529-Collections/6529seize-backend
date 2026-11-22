import {
  chainDayFixture,
  fixtureWallet,
  siteFixture,
  siteFixtureRows
} from '@/tests/fixtures/tdh-chain-day.fixture';
import { NftTDH } from '@/entities/ITDH';
import { applyChainTokenValues, applyChainValues } from './apply-chain-values';
import { chainClusterSource } from './chain-cluster-source';
import { verifyChainDay } from './chain-day-verify';
import { COLLECTION_CONTRACTS } from './site-day';

const X = `${fixtureWallet('1')}-${fixtureWallet('3')}`;
const when = new Date(0);

describe('applyChainValues', () => {
  it('changes nothing when the site computed what the chain holds', () => {
    const day = chainDayFixture();
    const rows = siteFixtureRows();
    const applied = applyChainValues(
      day,
      verifyChainDay(day).clusters,
      rows.wallets,
      rows.consolidated,
      when
    );
    expect(applied).toEqual({
      overrides: [],
      addedWallets: [],
      addedIdentities: []
    });
  });

  it('writes the chain totals over different site values, and 0 where there is no leaf', () => {
    const site = siteFixture();
    site.wallets[fixtureWallet('3')].boostedTdh = 401;
    site.identities[0].boostedTdh = 1499;
    site.wallets[fixtureWallet('6')].boostedTdh = 5;
    const rows = siteFixtureRows(site);
    const day = chainDayFixture();
    const applied = applyChainValues(
      day,
      verifyChainDay(day).clusters,
      rows.wallets,
      rows.consolidated,
      when
    );
    expect(applied.overrides).toEqual(
      expect.arrayContaining([
        {
          kind: 'WALLET',
          subject: fixtureWallet('3'),
          computed: 401,
          chain: 400
        },
        { kind: 'WALLET', subject: fixtureWallet('6'), computed: 5, chain: 0 },
        { kind: 'IDENTITY', subject: X, computed: 1499, chain: 1500 }
      ])
    );
    expect(
      rows.wallets.find((w) => w.wallet === fixtureWallet('3'))!.boosted_tdh
    ).toBe(400);
    expect(
      rows.consolidated.find((c) => c.consolidation_key === X)!.boosted_tdh
    ).toBe(1500);
  });

  it('adds rows for leaves the site has no row for', () => {
    const site = siteFixture();
    delete site.wallets[fixtureWallet('5')];
    site.identities = site.identities.filter(
      (i) => !i.wallets.includes(fixtureWallet('5'))
    );
    const rows = siteFixtureRows(site);
    const day = chainDayFixture();
    const applied = applyChainValues(
      day,
      verifyChainDay(day).clusters,
      rows.wallets,
      rows.consolidated,
      when
    );
    expect(applied.addedWallets).toEqual([fixtureWallet('5')]);
    expect(applied.addedIdentities).toEqual([fixtureWallet('5')]);
    const added = rows.consolidated.find(
      (c) => c.consolidation_key === fixtureWallet('5')
    )!;
    expect(added.boosted_tdh).toBe(77);
    expect(added.wallets).toEqual([fixtureWallet('5')]);
  });

  it('takes the per-collection sums from the token leaves', () => {
    const site = siteFixture();
    (site.identities[0] as any).memes = [{ id: 1, balance: 2, tdh: 999 }];
    const rows = siteFixtureRows(site);
    const day = chainDayFixture();
    const applied = applyChainValues(
      day,
      verifyChainDay(day).clusters,
      rows.wallets,
      rows.consolidated,
      when
    );
    expect(applied.overrides).toEqual([
      { kind: 'COLLECTION', subject: `${X}/memes`, computed: 1249, chain: 1250 }
    ]);
  });
});

describe('applyChainTokenValues', () => {
  it('sets each card value from the token leaves, 0 for a card without one', () => {
    const day = chainDayFixture();
    const nft = (id: number, contract: string, boosted: number) =>
      ({
        id,
        contract,
        consolidation_key: X,
        boosted_tdh: boosted
      }) as unknown as NftTDH;
    const rows = [
      nft(1, COLLECTION_CONTRACTS.memes, 1249),
      nft(5, COLLECTION_CONTRACTS.gradients, 250),
      nft(9, COLLECTION_CONTRACTS.memes, 3)
    ];
    const overrides = applyChainTokenValues(day, rows);
    expect(overrides.map((o) => [o.computed, o.chain])).toEqual([
      [1249, 1250],
      [3, 0]
    ]);
    expect(rows.map((r) => r.boosted_tdh)).toEqual([1250, 250, 0]);
    expect(applyChainTokenValues({ ...day, tokenLeaves: null }, rows)).toEqual(
      []
    );
  });
});

describe('chainClusterSource', () => {
  it('groups by the chain clusters and keys as 6529.io does', () => {
    const day = chainDayFixture();
    const source = chainClusterSource(verifyChainDay(day).clusters);
    expect(source.walletsOf(fixtureWallet('3'))).toEqual([
      fixtureWallet('1'),
      fixtureWallet('3')
    ]);
    expect(source.walletsOf(fixtureWallet('9'))).toEqual([fixtureWallet('9')]);
    expect(
      source.keysFor([
        fixtureWallet('1'),
        fixtureWallet('2'),
        fixtureWallet('9')
      ])
    ).toEqual({
      [fixtureWallet('1')]: X,
      [fixtureWallet('2')]: fixtureWallet('2'),
      [fixtureWallet('9')]: fixtureWallet('9')
    });
    expect(source.multiWalletAddresses()).toEqual([
      { wallet: fixtureWallet('1') },
      { wallet: fixtureWallet('3') }
    ]);
  });
});
