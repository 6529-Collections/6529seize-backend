insert into identities (consolidation_key, primary_address, handle, normalised_handle, banner1, banner2, classification,
                        sub_classification, profile_id, pfp, tdh, cic, rep, level_raw)
with consolidation_keys as (select distinct consolidation_key
                            from address_consolidation_keys),
     cics as (select r.matter_target_id as profile_id, sum(r.rating) as cic from ratings r where r.matter = 'CIC' group by 1),
     reps as (select r.matter_target_id as profile_id, sum(r.rating) as rep from ratings r where r.matter = 'REP' group by 1)
select c.consolidation_key                                             as consolidation_key,
       ifnull(p.primary_wallet, substring(c.consolidation_key, 1, 42)) as primary_wallet,
       p.handle                                                        as handle,
       p.normalised_handle                                             as normalised_handle,
       p.banner_1                                                      as banner1,
       p.banner_2                                                      as banner2,
       p.classification                                                as classification,
       p.sub_classification                                            as sub_classification,
       p.external_id                                                   as profile_id,
       p.pfp_url as pfp,
       ifnull(t.tdh, 0)                                                as tdh,
       ifnull(cics.cic, 0) as cic,
       ifnull(reps.rep, 0) as rep,
       ifnull(cics.cic, 0) + ifnull(t.tdh, 0) as level_raw
from consolidation_keys c
         left join profile_full pf on c.consolidation_key = pf.consolidation_key
         left join profiles p on p.external_id = pf.external_id
         left join tdh_consolidation t on c.consolidation_key = t.consolidation_key
         left join cics on cics.profile_id = p.external_id
         left join reps on reps.profile_id = p.external_id;