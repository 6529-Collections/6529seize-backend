export const MENTION_ALIAS_MIN_LENGTH = 3;
export const MENTION_ALIAS_MAX_LENGTH = 15;
export const MAX_MENTION_ALIASES_PER_PROFILE = 20;
export const MAX_MEMBERS_PER_MENTION_ALIAS = 25;

export const RESERVED_MENTION_ALIASES = new Set([
  'all',
  'everyone',
  'admin',
  'admins',
  'administrator',
  'administrators',
  'mod',
  'mods',
  'moderator',
  'moderators',
  'contributor',
  'contributors',
  'team',
  'dev',
  'devs',
  'developer',
  'developers',
  '6529devs',
  'devs6529'
]);

export function normalizeMentionAlias(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function isReservedMentionAlias(value: string): boolean {
  return RESERVED_MENTION_ALIASES.has(normalizeMentionAlias(value));
}
