CREATE TABLE IF NOT EXISTS community_app_clients (
  client_id varchar(64) NOT NULL,
  name varchar(100) NOT NULL,
  description varchar(255) NOT NULL,
  created_by_address varchar(255) NOT NULL,
  allowed_redirect_uris text NOT NULL,
  allowed_scopes varchar(255) NOT NULL DEFAULT 'identity:read',
  is_active tinyint(1) NOT NULL DEFAULT 1,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deactivated_at datetime(3) DEFAULT NULL,
  PRIMARY KEY (client_id),
  INDEX idx_community_app_clients_created_by (created_by_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;