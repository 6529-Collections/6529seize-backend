import { DEVS_6529_MENTION_TOKEN } from '@/constants/mentions';

/**
 * Text rules for model-written content posted as a drop:
 * - links stay clickable only when they are https URLs on an allowed origin;
 *   other Markdown links keep their label as plain text and other bare URLs
 *   and autolinks are removed;
 * - group mention tokens become plain words unless explicitly allowed;
 * - user mentions are kept only when the source text contains them (or when
 *   the caller opts out of that rule with `sourceText: null`).
 */

export const MODEL_OUTPUT_GROUP_MENTION_TOKENS: readonly string[] = [
  'all',
  'contributors',
  'admins',
  DEVS_6529_MENTION_TOKEN
];

export interface ModelOutputFilterOptions {
  /** Origins whose https links may stay clickable. */
  readonly allowedOrigins: readonly string[];
  /** Group mention tokens (without `@`) that may stay active. */
  readonly allowedGroupMentions?: readonly string[];
  /**
   * Text the output was grounded in. User mentions that also appear in this
   * text are kept; all others become plain handles. `null` leaves user
   * mentions unchanged.
   */
  readonly sourceText?: string | null;
  /** Handles (without `@`) that may always stay mentioned. */
  readonly alwaysAllowedHandles?: readonly string[];
}

const MARKDOWN_LINK_SOURCE = String.raw`(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"\n]*")?\s*\)`;
const AUTOLINK_SOURCE = String.raw`<([a-z][a-z0-9+.-]*:[^\s<>]*)>`;
const BARE_URL_SOURCE = String.raw`(?:https?:\/\/|www\.)[^\s<>()[\]]+`;
const LINK_TOKEN_PATTERN = new RegExp(
  `${MARKDOWN_LINK_SOURCE}|${AUTOLINK_SOURCE}|(${BARE_URL_SOURCE})`,
  'gi'
);
const TRAILING_URL_PUNCTUATION = /[.,;:!?'"]+$/;
const GROUP_MENTION_PATTERN = new RegExp(
  String.raw`(^|[^a-z0-9_@])@(${MODEL_OUTPUT_GROUP_MENTION_TOKENS.join('|')})(?![a-z0-9_@])`,
  'gi'
);
const BRACKETED_USER_MENTION_PATTERN =
  /(^|[^a-z0-9_@\\])@\[([^\]\n]{1,100})\]/gi;
const BARE_USER_MENTION_PATTERN =
  /(^|[^a-z0-9_@])@([a-z0-9_]{1,100})(?![a-z0-9_@])/gi;

function isAllowedUrl(
  candidate: string,
  allowedOrigins: readonly string[]
): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      allowedOrigins.includes(url.origin)
    );
  } catch {
    return false;
  }
}

function unescapeMarkdownLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1');
}

function collectSourceMentions(sourceText: string): Set<string> {
  const mentions = new Set<string>();
  const collect = (_match: string, _prefix: string, handle: string) => {
    mentions.add(handle.trim().toLowerCase());
    return '';
  };
  sourceText.replace(BRACKETED_USER_MENTION_PATTERN, collect);
  sourceText.replace(BARE_USER_MENTION_PATTERN, collect);
  return mentions;
}

interface MentionRules {
  readonly allowedGroupMentions: ReadonlySet<string>;
  readonly allowedUserMentions: ReadonlySet<string> | null;
  readonly alwaysAllowedHandles: ReadonlySet<string>;
}

/**
 * Drop writes derive group mentions from the raw text with this same token
 * boundary, inside URLs too, so this runs over the whole output.
 */
function filterGroupMentions(text: string, rules: MentionRules): string {
  return text.replace(
    GROUP_MENTION_PATTERN,
    (match, prefix: string, token: string) =>
      rules.allowedGroupMentions.has(token.toLowerCase())
        ? match
        : `${prefix}${token}`
  );
}

function filterUserMentions(text: string, rules: MentionRules): string {
  const allowedUsers = rules.allowedUserMentions;
  if (!allowedUsers) {
    return text;
  }
  const isAllowedUser = (handle: string) => {
    const normalized = handle.trim().toLowerCase();
    return (
      rules.alwaysAllowedHandles.has(normalized) ||
      allowedUsers.has(normalized) ||
      rules.allowedGroupMentions.has(normalized)
    );
  };
  return text
    .replace(
      BRACKETED_USER_MENTION_PATTERN,
      (match, prefix: string, handle: string) =>
        isAllowedUser(handle) ? match : `${prefix}${handle}`
    )
    .replace(
      BARE_USER_MENTION_PATTERN,
      (match, prefix: string, handle: string) =>
        isAllowedUser(handle) ? match : `${prefix}${handle}`
    );
}

function filterBareUrl(
  bareUrl: string,
  allowedOrigins: readonly string[]
): string {
  const trailing = TRAILING_URL_PUNCTUATION.exec(bareUrl)?.[0] ?? '';
  const url = bareUrl.slice(0, bareUrl.length - trailing.length);
  return isAllowedUrl(url, allowedOrigins) ? bareUrl : trailing;
}

function stripDisallowedBareUrls(
  text: string,
  allowedOrigins: readonly string[]
): string {
  return text.replace(new RegExp(BARE_URL_SOURCE, 'gi'), (bareUrl) =>
    filterBareUrl(bareUrl, allowedOrigins)
  );
}

function filterLinkToken(
  match: RegExpExecArray,
  allowedOrigins: readonly string[],
  rules: MentionRules
): string {
  const [whole, imageMarker, label, target, autolink, bareUrl] = match;
  if (label !== undefined) {
    if (!imageMarker && isAllowedUrl(target, allowedOrigins)) {
      return whole;
    }
    // A de-linked label must not become a bare link of its own.
    return filterUserMentions(
      stripDisallowedBareUrls(unescapeMarkdownLabel(label), allowedOrigins),
      rules
    );
  }
  if (autolink !== undefined) {
    return isAllowedUrl(autolink, allowedOrigins) ? whole : '';
  }
  return filterBareUrl(bareUrl, allowedOrigins);
}

function tidyWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,;!?])/g, '$1'))
    .join('\n')
    .trim();
}

export function filterModelOutputText(
  text: string,
  options: ModelOutputFilterOptions
): string {
  // Removing a link can join its neighbours into a new one, so repeat until
  // nothing changes. Every change shortens the text, so this terminates.
  let current = text;
  for (;;) {
    const next = filterOnce(current, options);
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function filterOnce(text: string, options: ModelOutputFilterOptions): string {
  const allowedOrigins = options.allowedOrigins;
  const rules: MentionRules = {
    alwaysAllowedHandles: new Set(
      (options.alwaysAllowedHandles ?? []).map((handle) => handle.toLowerCase())
    ),
    allowedGroupMentions: new Set(
      (options.allowedGroupMentions ?? []).map((token) => token.toLowerCase())
    ),
    allowedUserMentions:
      options.sourceText === null
        ? null
        : collectSourceMentions(options.sourceText ?? '')
  };
  let result = '';
  let lastIndex = 0;
  let changed = false;
  const pattern = new RegExp(LINK_TOKEN_PATTERN.source, 'gi');
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const replacement = filterLinkToken(match, allowedOrigins, rules);
    changed ||= replacement !== match[0];
    result += filterUserMentions(text.slice(lastIndex, match.index), rules);
    result += replacement;
    lastIndex = match.index + match[0].length;
  }
  result += filterUserMentions(text.slice(lastIndex), rules);
  result = filterGroupMentions(result, rules);
  if (!changed && result === text) {
    return text;
  }
  return tidyWhitespace(result);
}
