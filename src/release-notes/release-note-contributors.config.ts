/**
 * Map lowercase GitHub logins to canonical 6529.io profile handles.
 *
 * Keep this versioned and reviewable. Unmapped contributors are linked to
 * their GitHub profiles without creating a 6529 mention.
 */
export const GITHUB_TO_6529_HANDLES: Readonly<Record<string, string>> =
  Object.freeze({
    brookr: 'brookr',
    gelatogenesis: 'GelatoGenesis',
    prxt6529: 'prxt0',
    punk6529: 'punk6529',
    ragnep: 'ragne',
    simo6529: 'simo'
  });
