update drops_votes_credit_spendings
    inner join (select wave_id, id as drop_id
                from drops) as ds on ds.drop_id = drops_votes_credit_spendings.drop_id
set drops_votes_credit_spendings.wave_id = ds.wave_id
where drops_votes_credit_spendings.wave_id is null;