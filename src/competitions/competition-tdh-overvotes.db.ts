import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  IDENTITIES_TABLE,
  TDH_NFT_TABLE
} from '@/constants';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { competitionCreditNfts } from './competition-credit-nfts';
import { Competition } from './competition.types';

function creditSource(competition: Pick<Competition, 'voting'>): {
  sql: string;
  params: Record<string, unknown>;
} {
  // SQL column expressions form a closed allowlist, independent of caller text.
  const fields: Partial<Record<WaveCreditType, string>> = {
    [WaveCreditType.TDH]: 'i.tdh',
    [WaveCreditType.XTDH]: 'i.xtdh',
    [WaveCreditType.TDH_PLUS_XTDH]: '(i.tdh + i.xtdh)'
  };
  const field = fields[competition.voting.credit_type as WaveCreditType];
  if (field)
    return {
      sql: `select i.profile_id, ${field} as available from ${IDENTITIES_TABLE} i`,
      params: {}
    };
  if (competition.voting.credit_type !== WaveCreditType.CARD_SET_TDH)
    throw new Error('TDH overvote discovery requires a TDH-based credit type');
  return {
    // Match the public budget: deduplicate NFTs, take the maximum per NFT across
    // the profile's consolidation keys, then sum that configured set only.
    // JSON_TABLE and persisted columns may inherit different collations. Hex
    // addresses use one explicit case-insensitive collation at that boundary.
    sql: `select profile_id, sum(credit) as available from (
      select spending.profile_id, nft.contract, nft.token_id,
        coalesce(max(t.boosted_tdh), 0) as credit
      from active_spending spending
      cross join json_table(:creditNfts, '$[*]' columns (
        contract varchar(50) path '$.contract', token_id bigint path '$.tokenId'
      )) nft
      left join ${IDENTITIES_TABLE} i on i.profile_id = spending.profile_id
      left join ${TDH_NFT_TABLE} t on t.consolidation_key = i.consolidation_key
        and t.contract = convert(nft.contract using utf8mb4) collate utf8mb4_unicode_ci
        and t.id = nft.token_id
      group by spending.profile_id, nft.contract, nft.token_id
    ) nft_credit group by profile_id`,
    params: {
      creditNfts: JSON.stringify(competitionCreditNfts(competition.voting))
    }
  };
}

export class CompetitionTdhOvervotesDb extends LazyDbAccessCompatibleService {
  /** The caller holds the competition lock on the TDH publication transaction.
   * Only candidates cross into the per-voter mutation/notification path. */
  public async findOvervoters(
    competition: Pick<Competition, 'id' | 'voting'>,
    ctx: RequestContext
  ): Promise<string[]> {
    const timerName = `${this.constructor.name}->findOvervoters`;
    ctx.timer?.start(timerName);
    try {
      if (!ctx.connection)
        throw new Error(
          'TDH overvote discovery requires the competition transaction lock'
        );
      const scope = competition.voting.credit_scope;
      if (scope !== WaveCreditScope.WAVE && scope !== WaveCreditScope.DROP)
        throw new Error(`Unsupported competition credit scope: ${scope}`);
      const source = creditSource(competition);
      const rows = await this.db.execute<{ profile_id: string }>(
        `with active_spending as (
          select v.voter_profile_id as profile_id,
            ${scope === WaveCreditScope.WAVE ? 'sum' : 'max'}(abs(v.value)) as spent
          from ${COMPETITION_VOTES_TABLE} v
          join ${COMPETITION_ENTRIES_TABLE} e
            on e.competition_id = v.competition_id and e.id = v.entry_id
          where v.competition_id = :competitionId and e.status = 'ACTIVE'
            and v.value <> 0
          group by v.voter_profile_id
        ), credit as (${source.sql})
        select distinct spending.profile_id from active_spending spending
        left join credit on credit.profile_id = spending.profile_id
        where spending.spent > greatest(0, floor(coalesce(credit.available, 0)))
        order by spending.profile_id asc`,
        { competitionId: competition.id, ...source.params },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => row.profile_id);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionTdhOvervotesDb = new CompetitionTdhOvervotesDb(
  dbSupplier
);
