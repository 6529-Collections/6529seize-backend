/**
 * Map lowercase GitHub logins to canonical 6529.io profile handles.
 *
 * Keep this versioned and reviewable. Unmapped contributors are linked to
 * their GitHub profiles without creating a 6529 mention.
 */
export const GITHUB_CONTRIBUTOR_LOGIN_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?:\[bot\])?$/;

export function isGithubContributorLogin(value: string): boolean {
  return value.length <= 39 && GITHUB_CONTRIBUTOR_LOGIN_PATTERN.test(value);
}

export const GITHUB_TO_6529_HANDLES: Readonly<Record<string, string>> =
  Object.freeze({
    brookr: 'brookr',
    gelatogenesis: 'GelatoGenesis',
    prxt6529: 'prxt0',
    punk6529: 'punk6529',
    ragnep: 'ragne',
    simo6529: 'simo'
  });
