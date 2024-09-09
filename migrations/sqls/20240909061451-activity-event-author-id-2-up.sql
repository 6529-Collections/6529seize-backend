update activity_events
set action_author_id = JSON_UNQUOTE(JSON_EXTRACT(data, '$.replier_id'))
where target_type = 'DROP' and action = 'DROP_REPLIED';