UPDATE waves
JOIN community_groups
  ON (waves.chat_group_id = community_groups.id OR 
      (waves.chat_group_id IS NULL AND waves.admin_group_id = community_groups.id))
SET waves.is_direct_message = community_groups.is_direct_message;