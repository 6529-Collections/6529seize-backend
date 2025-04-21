insert into profile_activity_logs (id, profile_id, contents, type, created_at)
select uuid(), external_id, '{}', 'PROFILE_CREATED', created_at from profiles;