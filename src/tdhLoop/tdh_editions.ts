import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '../constants';
import { ConsolidatedTDH, TDH } from '../entities/ITDH';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../nextgen/nextgen_constants';

export type BaseTDHEditionsRow = {
  contract: string;
  id: number;
  edition_id: number;
  balance: number;
  hodl_rate: number;
  days_held: number;
  tdh: number;
  boost: number;
  boosted_tdh: number;
};

export type TDHEditionsRow = BaseTDHEditionsRow & { wallet: string };
export type ConsolidatedTDHEditionsRow = BaseTDHEditionsRow & {
  consolidation_key: string;
};

export async function calculateTdhEditions(
  tdh: TDH[],
  isConsolidation?: false
): Promise<TDHEditionsRow[]>;
export async function calculateTdhEditions(
  tdh: ConsolidatedTDH[],
  isConsolidation: true
): Promise<ConsolidatedTDHEditionsRow[]>;
export async function calculateTdhEditions(
  tdh: Array<TDH | ConsolidatedTDH>,
  isConsolidation?: boolean
): Promise<Array<TDHEditionsRow | ConsolidatedTDHEditionsRow>> {
  const rows: Array<TDHEditionsRow | ConsolidatedTDHEditionsRow> = [];

  const nextgenContract = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];

  function pushCollectionItems(
    collection: Array<{
      id: number;
      balance: number;
      hodl_rate: number;
      days_held_per_edition: number[];
    }>,
    contract: string,
    owner: { wallet: string } | { consolidation_key: string },
    boost: number
  ) {
    for (const token of collection) {
      const { id, balance, hodl_rate, days_held_per_edition } = token;
      for (let i = 0; i < days_held_per_edition.length; i += 1) {
        const daysHeld = days_held_per_edition[i];
        const tdh = daysHeld * hodl_rate;
        const boostedTdh = tdh * boost;
        const shared: BaseTDHEditionsRow = {
          contract,
          id,
          edition_id: i + 1,
          balance,
          hodl_rate,
          days_held: days_held_per_edition[i],
          tdh: tdh,
          boost: boost,
          boosted_tdh: boostedTdh
        };
        rows.push({ ...owner, ...shared } as
          | TDHEditionsRow
          | ConsolidatedTDHEditionsRow);
      }
    }
  }

  for (const t of tdh) {
    const owner = isConsolidation
      ? { consolidation_key: (t as ConsolidatedTDH).consolidation_key }
      : { wallet: (t as TDH).wallet };

    pushCollectionItems((t as any).memes ?? [], MEMES_CONTRACT, owner, t.boost);
    pushCollectionItems(
      (t as any).gradients ?? [],
      GRADIENT_CONTRACT,
      owner,
      t.boost
    );
    pushCollectionItems(
      (t as any).nextgen ?? [],
      nextgenContract,
      owner,
      t.boost
    );
  }

  return rows as any;
}
