INSERT INTO community_app_clients
  (client_id, name, description, created_by_address, allowed_redirect_uris, allowed_scopes, is_active, created_at)
VALUES
  (
    'ar-community-platform',
    '6529 AR Platform',
    'World-anchored AR layer gated by 6529.io identity',
    '0x0000000000000000000000000000000000000000',
    '["https://arweave.net/6529-ar/auth/callback"]',
    'identity:read',
    1,
    NOW(3)
  );