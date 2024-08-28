update drops_referenced_nfts
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drops_referenced_nfts.drop_id
set drops_referenced_nfts.wave_id = ds.wave_id
where drops_referenced_nfts.wave_id is null;