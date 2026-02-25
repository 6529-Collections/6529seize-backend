insert into memes_prevote_artist_profiles (card_no, profile_id)
with memes as
         (select n.id, case when artist = '6529' then 'punk6529' else artist end as artist
          from nfts n
          where n.contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1'
            and id <= 342)
select memes.id, identities.profile_id
from memes
         left join identities on identities.handle = memes.artist
where identities.profile_id is not null
order by memes.id;