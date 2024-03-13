create or replace view profile_full as
(
    with unioned_profiles as (select p.*,
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
                                   join community_members cm on p.primary_wallet = cm.wallet3)
    select up.*,
           ifnull(tc.boosted_tdh, 0) as profile_tdh,
           ifnull(cic.score, 0)      as cic_score,
           ifnull(rep.score, 0)      as rep_score
    from unioned_profiles up
             left join cic_score_aggregations cic on up.external_id = cic.profile_id
             left join profile_total_rep_score_aggregations rep on up.external_id = rep.profile_id
             left join tdh_consolidation tc on tc.consolidation_key = up.consolidation_key
);