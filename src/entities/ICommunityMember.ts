import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  ViewColumn,
  ViewEntity
} from 'typeorm';
import {
  ALL_COMMUNITY_MEMBERS_VIEW,
  COMMUNITY_MEMBERS_TABLE,
  PROFILE_FULL,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../constants';
import { ProfileClassification, ProfileType } from './IProfile';

@Entity(COMMUNITY_MEMBERS_TABLE)
export class CommunityMember {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  readonly consolidation_key!: string;
  @Index()
  @Column({ type: 'varchar', length: 50 })
  readonly wallet1!: string;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly wallet2!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly wallet3!: string | null;
}

@ViewEntity({
  name: PROFILE_FULL,
  expression: `
  with unioned_profiles as (
   select p.*,
                   cm.consolidation_key as consolidation_key,
                   cm.wallet1           as wallet1,
                   cm.wallet2           as wallet2,
                   cm.wallet3           as wallet3
            from profiles p
                     join community_members cm on p.primary_wallet = cm.wallet1
            union all
            select p.*,
                   cm.consolidation_key as consolidation_key,
                   cm.wallet1           as wallet1,
                   cm.wallet2           as wallet2,
                   cm.wallet3           as wallet3
            from profiles p
                     join community_members cm on p.primary_wallet = cm.wallet2
            union all
            select p.*,
                   cm.consolidation_key as consolidation_key,
                   cm.wallet1           as wallet1,
                   cm.wallet2           as wallet2,
                   cm.wallet3           as wallet3
            from profiles p
                     join community_members cm on p.primary_wallet = cm.wallet3
  ) select up.*, 
           ifnull(tc.boosted_tdh, 0) as profile_tdh,
           ifnull(cic.score, 0) as cic_score,
           ifnull(rep.score, 0) as rep_score
           from unioned_profiles up 
               left join cic_score_aggregations cic on up.external_id = cic.profile_id
               left join profile_total_rep_score_aggregations rep on up.external_id = rep.profile_id
               left join tdh_consolidation tc on tc.consolidation_key = up.consolidation_key
`
})
export class ProfileFullView implements ProfileType {
  @ViewColumn()
  readonly external_id!: string;
  @ViewColumn()
  readonly normalised_handle!: string;
  @ViewColumn()
  readonly handle!: string;
  @ViewColumn()
  readonly primary_wallet!: string;
  @ViewColumn()
  readonly created_at!: Date;
  @ViewColumn()
  readonly created_by_wallet!: string;
  @ViewColumn()
  readonly updated_at?: Date | null;
  @ViewColumn()
  readonly updated_by_wallet?: string;
  @ViewColumn()
  readonly pfp_url?: string;
  @ViewColumn()
  readonly banner_1?: string;
  @ViewColumn()
  readonly banner_2?: string;
  @ViewColumn()
  readonly website?: string;
  @ViewColumn()
  readonly classification?: ProfileClassification | null;
  @ViewColumn()
  readonly consolidation_key!: string;
  @ViewColumn()
  readonly wallet1!: string;
  @ViewColumn()
  readonly wallet2!: string | null;
  @ViewColumn()
  readonly wallet3!: string | null;
}

@ViewEntity({
  name: WALLETS_CONSOLIDATION_KEYS_VIEW,
  expression: `
    select wallet1 as wallet, consolidation_key
    from community_members
    union all
    select wallet2 as wallet, consolidation_key
    from community_members
    union all
    select wallet3 as wallet, consolidation_key
    from community_members
`
})
export class WalletConsolidationKeyView {
  @ViewColumn()
  readonly wallet!: string;
  @ViewColumn()
  readonly consolidation_key!: string;
}

@ViewEntity({
  name: ALL_COMMUNITY_MEMBERS_VIEW,
  expression: `
    select
        profile_full.external_id as profile_id,
        profile_full.consolidation_key,
        profile_full.wallet1,
        profile_full.wallet2,
        profile_full.wallet3,
        profile_full.profile_tdh as tdh,
        profile_full.rep_score as rep,
        profile_full.cic_score as cic,
        profile_full.pfp_url as pfp,
        profile_full.handle as handle,
        profile_full.profile_tdh + profile_full.rep_score as level,
        profile_full.handle as display
    from profile_full
    union all
    select
        null as profile_id,
        community_members.consolidation_key,
        community_members.wallet1,
        community_members.wallet2,
        community_members.wallet3,
        tdh_consolidation.boosted_tdh as tdh,
        null as rep,
        null as cic,
        null as pfp,
        null as handle,
        tdh_consolidation.boosted_tdh as level,
        tdh_consolidation.consolidation_display as display
    from community_members
             join tdh_consolidation on tdh_consolidation.consolidation_key = community_members.consolidation_key
             left join profile_full on profile_full.consolidation_key = community_members.consolidation_key
    where profile_full.consolidation_key is null
`
})
export class CommunityMemberView {
  readonly consolidation_key!: string;
  @ViewColumn()
  readonly profile_id!: string | null;
  @ViewColumn()
  readonly level!: number;
  @ViewColumn()
  readonly tdh!: number;
  @ViewColumn()
  readonly rep!: number;
  @ViewColumn()
  readonly cic!: number;
  @ViewColumn()
  readonly pfp!: string | null;
  @ViewColumn()
  readonly handle!: string | null;
  @ViewColumn()
  readonly wallet1!: string;
  @ViewColumn()
  readonly wallet2!: string | null;
  @ViewColumn()
  readonly wallet3!: string | null;
  @ViewColumn()
  readonly display!: string;
}
