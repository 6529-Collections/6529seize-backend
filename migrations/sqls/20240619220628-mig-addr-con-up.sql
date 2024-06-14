insert into address_consolidation_keys (address, consolidation_key)
with wallets as (select distinct wallet, consolidation_key
                 from (select wallet1 as wallet, consolidation_key
                       from community_members
                       union all
                       select wallet2 as wallet, consolidation_key
                       from community_members
                       union all
                       select wallet3 as wallet, consolidation_key
                       from community_members) x)
select wallet, consolidation_key
from wallets where wallet is not null;