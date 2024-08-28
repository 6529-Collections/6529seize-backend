update drops_metadatas
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drops_metadatas.drop_id
set drops_metadatas.wave_id = ds.wave_id
where drops_metadatas.wave_id is null;