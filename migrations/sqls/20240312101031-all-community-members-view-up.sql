create or replace view all_community_members as (
                                              select profile_full.external_id as profile_id,
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
);