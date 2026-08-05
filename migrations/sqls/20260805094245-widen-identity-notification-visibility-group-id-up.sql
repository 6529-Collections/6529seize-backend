ALTER TABLE identity_notifications
  MODIFY COLUMN visibility_group_id varchar(100) NULL DEFAULT NULL,
  ALGORITHM=INPLACE,
  LOCK=NONE;

UPDATE identity_notifications n
INNER JOIN waves w ON w.id = n.wave_id
SET n.visibility_group_id = w.visibility_group_id
WHERE n.visibility_group_id IS NOT NULL
  AND w.visibility_group_id IS NOT NULL
  -- Notification visibility is copied from its wave. Joining by wave ID keeps
  -- the repair authoritative even when different groups share a 50-char prefix.
  AND CHAR_LENGTH(n.visibility_group_id) = 50
  AND CHAR_LENGTH(w.visibility_group_id) > 50
  AND n.visibility_group_id = LEFT(w.visibility_group_id, 50);
