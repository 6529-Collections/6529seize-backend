update waves
set chat_group_id = participation_group_id
where chat_group_id is null
  and type = 'CHAT'
  and participation_group_id is not null;