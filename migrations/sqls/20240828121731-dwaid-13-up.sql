update drops_parts
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drops_parts.drop_id
set drops_parts.wave_id = ds.wave_id
where drops_parts.wave_id is null;