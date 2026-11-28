import { ConsolidatedTDH, TDH, TokenTDH } from '@/entities/ITDH';
import { getConsolidationWallets } from '@/tdhLoop/consolidation-wallets';
import { compareText } from './p28';
import {
  SITE_COLLECTIONS,
  SiteCollection,
  SiteDay,
  SiteDayBuilder,
  SiteToken
} from './site-day';

/**
 * A SiteDay from TDH rows: the live tables (the shadow ingest's comparison)
 * or the rows the site computed in memory for a chain day (its cache check).
 */

function rowTokens(row: TDH | ConsolidatedTDH): SiteToken[] {
  const tokens: SiteToken[] = [];
  for (const collection of SITE_COLLECTIONS) {
    const list = (row as any)[collection] as TokenTDH[] | null | undefined;
    for (const t of list ?? []) {
      tokens.push({
        collection: collection as SiteCollection,
        tokenId: String(t.id),
        tdh: Number(t.tdh),
        balance: Number(t.balance)
      });
    }
  }
  return tokens;
}

export function siteDayFromRows(
  block: number,
  date: string,
  walletRows: readonly TDH[],
  consolidatedRows: readonly ConsolidatedTDH[]
): SiteDay {
  const builder = new SiteDayBuilder();
  walletRows.forEach((row, i) => {
    builder.addWallet(
      Number(row.block),
      date,
      {
        wallet: row.wallet.toLowerCase(),
        boostedTdh: Number(row.boosted_tdh),
        holds: rowTokens(row).some((t) => t.balance > 0)
      },
      `wallet row ${i + 1}`
    );
  });
  consolidatedRows.forEach((row, i) => {
    const wallets = getConsolidationWallets(row)
      .map((w) => w.toLowerCase())
      .sort(compareText);
    builder.addIdentity(
      Number(row.block),
      date,
      {
        key: row.consolidation_key.toLowerCase(),
        wallets,
        boostedTdh: Number(row.boosted_tdh),
        boost: Number(row.boost),
        tokens: rowTokens(row)
      },
      `consolidated row ${i + 1}`
    );
  });
  if (walletRows.length === 0 && consolidatedRows.length === 0) {
    return {
      block,
      date,
      wallets: new Map(),
      identities: new Map(),
      notes: ['no rows']
    };
  }
  return builder.build();
}
