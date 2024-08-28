update drops_mentions
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drops_mentions.drop_id
set drops_mentions.wave_id = ds.wave_id
where drops_mentions.wave_id is null;