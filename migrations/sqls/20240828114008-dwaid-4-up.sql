update drop_medias
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drop_medias.drop_id
set drop_medias.wave_id = ds.wave_id
where drop_medias.wave_id is null;