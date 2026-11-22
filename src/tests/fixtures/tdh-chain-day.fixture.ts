import { keccak256, toUtf8Bytes } from 'ethers';
import { ConsolidatedTDH, TDH } from '@/entities/ITDH';
import { csvField } from '@/tdhChain/csv';
import { cidOf, tokenRoot, walletRoot } from '@/tdhChain/p28';
import { COLLECTION_CONTRACTS } from '@/tdhChain/site-day';
import {
  TdhChainDay,
  TdhTokenLeaf,
  TdhWalletLeaf
} from '@/tdhChain/tdh-chain.types';

/**
 * P28 4.11's day (cycle 20737, 11 Oct 2026) on both sides: the chain's
 * header and lists, and 6529.io's two uploads with the same values. Wallets
 * 0x11..11 and 0x33..33 are consolidation X; 0x44..44 holds a card less than
 * a day old; 0x66..66 holds nothing and has a zero row on the site only.
 * Addresses are made up.
 */
export const fixtureWallet = (digit: string) => `0x${digit.repeat(40)}`;

export const FIXTURE_CYCLE_DAY = 20737;
export const FIXTURE_DATE = '20261011';
export const FIXTURE_BLOCK = 26165481;

const W = {
  a: fixtureWallet('1'),
  b: fixtureWallet('2'),
  c: fixtureWallet('3'),
  d: fixtureWallet('4'),
  e: fixtureWallet('5'),
  zero: fixtureWallet('6')
};

interface FixtureToken {
  readonly id: number | string;
  readonly balance: number;
  readonly tdh: number;
}

interface FixtureRow {
  boostedTdh: number;
  boost: number;
  memes?: FixtureToken[];
  gradients?: FixtureToken[];
  nextgen?: FixtureToken[];
}

interface FixtureIdentity extends FixtureRow {
  wallets: string[];
}

/** Mutable on purpose: tests edit it to make one difference at a time. */
export interface SiteFixture {
  block: number;
  date: string;
  wallets: Record<string, FixtureRow>;
  identities: FixtureIdentity[];
}

/** 6529.io's side of the day, editable before it is written out. */
export function siteFixture(): SiteFixture {
  return {
    block: FIXTURE_BLOCK,
    date: FIXTURE_DATE,
    wallets: {
      [W.a]: {
        boostedTdh: 1000,
        boost: 1.25,
        memes: [{ id: 1, balance: 1, tdh: 800 }]
      },
      [W.b]: {
        boostedTdh: 250,
        boost: 1,
        memes: [{ id: 2, balance: 1, tdh: 250 }]
      },
      [W.c]: {
        boostedTdh: 400,
        boost: 1.1,
        memes: [{ id: 1, balance: 1, tdh: 200 }],
        gradients: [{ id: 5, balance: 1, tdh: 200 }]
      },
      [W.d]: {
        boostedTdh: 0,
        boost: 1,
        memes: [{ id: 3, balance: 1, tdh: 0 }]
      },
      [W.e]: {
        boostedTdh: 77,
        boost: 1.1,
        nextgen: [{ id: '10000000013', balance: 1, tdh: 70 }]
      },
      [W.zero]: { boostedTdh: 0, boost: 1 }
    },
    identities: [
      {
        wallets: [W.a, W.c],
        boostedTdh: 1500,
        boost: 1.25,
        memes: [{ id: 1, balance: 2, tdh: 1000 }],
        gradients: [{ id: 5, balance: 1, tdh: 200 }]
      },
      {
        wallets: [W.b],
        boostedTdh: 250,
        boost: 1,
        memes: [{ id: 2, balance: 1, tdh: 250 }]
      },
      {
        wallets: [W.d],
        boostedTdh: 0,
        boost: 1,
        memes: [{ id: 3, balance: 1, tdh: 0 }]
      },
      {
        wallets: [W.e],
        boostedTdh: 77,
        boost: 1.1,
        nextgen: [{ id: '10000000013', balance: 1, tdh: 70 }]
      },
      { wallets: [W.zero], boostedTdh: 0, boost: 1 }
    ]
  };
}

const COMMON_COLUMNS = [
  'block',
  'date',
  'total_balance',
  'boosted_tdh',
  'tdh_rank',
  'tdh',
  'tdh__raw',
  'boost',
  'memes_balance',
  'unique_memes',
  'memes_cards_sets',
  'memes_cards_sets_minus1',
  'memes_cards_sets_minus2',
  'genesis',
  'nakamoto',
  'boosted_memes_tdh',
  'memes_tdh',
  'memes_tdh__raw',
  'tdh_rank_memes',
  'memes',
  'gradients_balance',
  'boosted_gradients_tdh',
  'gradients_tdh',
  'gradients_tdh__raw',
  'tdh_rank_gradients',
  'gradients',
  'nextgen_balance',
  'boosted_nextgen_tdh',
  'nextgen_tdh',
  'nextgen_tdh__raw',
  'nextgen',
  'boost_breakdown'
];

function tokenJson(tokens: FixtureToken[] | undefined): string {
  return JSON.stringify(
    (tokens ?? []).map((t) => ({
      id: t.id,
      balance: t.balance,
      hodl_rate: 1,
      tdh: t.tdh,
      tdh__raw: t.tdh,
      days_held_per_edition: [t.tdh],
      rank: 1
    }))
  );
}

function commonCells(site: SiteFixture, row: FixtureRow): string[] {
  const values: Record<string, string> = {
    block: String(site.block),
    date: site.date,
    boosted_tdh: String(row.boostedTdh),
    boost: String(row.boost),
    memes: tokenJson(row.memes),
    gradients: tokenJson(row.gradients),
    nextgen: tokenJson(row.nextgen),
    boost_breakdown: '{}'
  };
  return COMMON_COLUMNS.map((c) => csvField(values[c] ?? '0'));
}

/** The two uploads as 6529.io writes them. */
export function siteUploadsCsv(site: SiteFixture = siteFixture()): {
  wallets: string;
  consolidated: string;
} {
  const walletLines = [['wallet', ...COMMON_COLUMNS].join(',')];
  for (const [wallet, row] of Object.entries(site.wallets)) {
    walletLines.push([wallet, ...commonCells(site, row)].join(','));
  }
  const consolidatedLines = [
    [
      'consolidation_key',
      'consolidation_display',
      'wallets',
      ...COMMON_COLUMNS
    ].join(',')
  ];
  for (const identity of site.identities) {
    const wallets = identity.wallets.slice().sort();
    consolidatedLines.push(
      [
        wallets.join('-'),
        csvField(wallets.join(' - ')),
        csvField(JSON.stringify(wallets)),
        ...commonCells(site, identity)
      ].join(',')
    );
  }
  return {
    wallets: walletLines.join('\n') + '\n',
    consolidated: consolidatedLines.join('\n') + '\n'
  };
}

/** The chain's side of the day: P28 4.11's leaves, header and tokens. */
export function chainDayFixture(): TdhChainDay {
  const x = cidOf([W.a, W.c]);
  const walletLeaves: TdhWalletLeaf[] = [
    { wallet: W.a, cid: x, identityTdh: 1500, walletTdh: 1000, walletCount: 2 },
    {
      wallet: W.b,
      cid: cidOf([W.b]),
      identityTdh: 250,
      walletTdh: 250,
      walletCount: 1
    },
    { wallet: W.c, cid: x, identityTdh: 1500, walletTdh: 400, walletCount: 2 },
    {
      wallet: W.d,
      cid: cidOf([W.d]),
      identityTdh: 0,
      walletTdh: 0,
      walletCount: 1
    },
    {
      wallet: W.e,
      cid: cidOf([W.e]),
      identityTdh: 77,
      walletTdh: 77,
      walletCount: 1
    }
  ];
  const tokenLeaves: TdhTokenLeaf[] = [
    {
      cid: cidOf([W.b]),
      contract: COLLECTION_CONTRACTS.memes,
      tokenId: '2',
      tokenTdh: 250
    },
    {
      cid: x,
      contract: COLLECTION_CONTRACTS.gradients,
      tokenId: '5',
      tokenTdh: 250
    },
    {
      cid: x,
      contract: COLLECTION_CONTRACTS.memes,
      tokenId: '1',
      tokenTdh: 1250
    },
    {
      cid: cidOf([W.e]),
      contract: COLLECTION_CONTRACTS.nextgen,
      tokenId: '10000000013',
      tokenTdh: 77
    }
  ];
  return {
    header: {
      cycleDay: FIXTURE_CYCLE_DAY,
      boundary: FIXTURE_CYCLE_DAY * 86400,
      tdhRuleId: keccak256(toUtf8Bytes('fixture rule')),
      cutoffNumber: FIXTURE_BLOCK,
      cutoffHash: keccak256(toUtf8Bytes('fixture cutoff')),
      cutoffTimestamp: FIXTURE_CYCLE_DAY * 86400 - 1,
      walletRoot: walletRoot(walletLeaves),
      walletCount: walletLeaves.length,
      identityCount: 4,
      totalTdh: 1827,
      tokenRoot: tokenRoot(tokenLeaves),
      tokenCount: tokenLeaves.length
    },
    apply: {
      applyHeight: 1200,
      applyBlockHash: keccak256(toUtf8Bytes('fixture apply block')),
      applyTimeMs: FIXTURE_CYCLE_DAY * 86400000 + 1800000,
      finalizedHeight: 1260
    },
    walletLeaves,
    tokenLeaves
  };
}

function tokenRows(tokens: FixtureToken[] | undefined) {
  return (tokens ?? []).map((t) => ({
    id: t.id,
    balance: t.balance,
    hodl_rate: 1,
    tdh: t.tdh,
    tdh__raw: t.tdh,
    days_held_per_edition: [t.tdh]
  }));
}

function rowFields(site: SiteFixture, row: FixtureRow) {
  const memes = tokenRows(row.memes);
  const gradients = tokenRows(row.gradients);
  const nextgen = tokenRows(row.nextgen);
  const sum = (list: { tdh: number }[]) => list.reduce((a, t) => a + t.tdh, 0);
  const boosted = (list: { tdh: number }[]) =>
    list.reduce((a, t) => a + Math.round(t.tdh * row.boost), 0);
  return {
    block: site.block,
    date: new Date(FIXTURE_CYCLE_DAY * 86400000 - 1000),
    boosted_tdh: row.boostedTdh,
    boost: row.boost,
    tdh: sum(memes) + sum(gradients) + sum(nextgen),
    tdh__raw: sum(memes) + sum(gradients) + sum(nextgen),
    balance: [...memes, ...gradients, ...nextgen].reduce(
      (a, t) => a + t.balance,
      0
    ),
    tdh_rank: 0,
    tdh_rank_memes: 0,
    tdh_rank_gradients: 0,
    tdh_rank_nextgen: 0,
    boosted_memes_tdh: boosted(memes),
    boosted_gradients_tdh: boosted(gradients),
    boosted_nextgen_tdh: boosted(nextgen),
    memes_tdh: sum(memes),
    gradients_tdh: sum(gradients),
    nextgen_tdh: sum(nextgen),
    memes,
    gradients,
    nextgen,
    memes_ranks: [],
    gradients_ranks: [],
    nextgen_ranks: []
  };
}

/** The same day as TDH table rows, as the TDH loop builds them. */
export function siteFixtureRows(site: SiteFixture = siteFixture()): {
  wallets: TDH[];
  consolidated: ConsolidatedTDH[];
} {
  return {
    wallets: Object.entries(site.wallets).map(
      ([wallet, row]) => ({ ...rowFields(site, row), wallet }) as unknown as TDH
    ),
    consolidated: site.identities.map((identity) => {
      const wallets = identity.wallets.slice().sort();
      return {
        ...rowFields(site, identity),
        consolidation_key: wallets.join('-'),
        consolidation_display: wallets.join(' - '),
        wallets,
        boosted_tdh_rate: 0
      } as unknown as ConsolidatedTDH;
    })
  };
}
