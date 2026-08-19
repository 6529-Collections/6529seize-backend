CREATE TABLE IF NOT EXISTS profile_preferences (
  profile_id varchar(50) NOT NULL,
  direct_message_policy varchar(30) NOT NULL DEFAULT 'EVERYONE',
  notification_level varchar(30) NOT NULL DEFAULT 'ALL',
  notify_direct_messages boolean NOT NULL DEFAULT true,
  notify_mentions_replies_quotes boolean NOT NULL DEFAULT true,
  notify_reactions_votes_boosts boolean NOT NULL DEFAULT true,
  notify_new_followers boolean NOT NULL DEFAULT true,
  notify_rep_and_nic boolean NOT NULL DEFAULT true,
  notify_subscription_coverage boolean NOT NULL DEFAULT true,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
