UPDATE waves
LEFT JOIN community_groups
  ON (waves.chat_group_id = community_groups.id OR 
      (waves.chat_group_id IS NULL AND waves.admin_group_id = community_groups.id))
SET waves.is_direct_message = CASE
  WHEN community_groups.is_direct_message IS NOT NULL THEN community_groups.is_direct_message
  ELSE FALSE
END;