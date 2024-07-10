insert into profile_groups (profile_group_id, profile_id)
select distinct g.wallet_group_id, i.profile_id from wallet_group g
                                                         join address_consolidation_keys a on g.wallet = a.address
                                                         join identities i on i.consolidation_key = a.consolidation_key;