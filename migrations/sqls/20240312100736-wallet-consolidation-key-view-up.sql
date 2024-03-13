create or replace view wallet_consolidation_key as
(
    select wallet1 as wallet, consolidation_key
    from community_members
    union all
    select wallet2 as wallet, consolidation_key
    from community_members
    union all
    select wallet3 as wallet, consolidation_key
    from community_members
);