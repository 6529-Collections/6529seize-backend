update activity_events
set action_author_id = target_id
where target_type = 'IDENTITY';