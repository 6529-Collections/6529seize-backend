CREATE TABLE IF NOT EXISTS profile_cms_publish_signatures (
  id varchar(100) NOT NULL,
  typed_data_hash varchar(100) NOT NULL,
  profile_id varchar(100) NOT NULL,
  package_db_id varchar(100) NOT NULL,
  package_id varchar(128) NOT NULL,
  package_version int NOT NULL,
  package_hash varchar(100) NOT NULL,
  signer_address varchar(42) NOT NULL,
  deadline bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY idx_profile_cms_publish_signatures_hash (typed_data_hash),
  KEY idx_profile_cms_publish_signatures_profile_created (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
