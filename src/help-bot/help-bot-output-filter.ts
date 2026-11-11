import { HELP_BOT_BASE_URL, HELP_BOT_HANDLE } from './help-bot.config';
import {
  filterModelOutputText,
  MODEL_OUTPUT_GROUP_MENTION_TOKENS
} from '@/model-output-filter';

/**
 * Final text rules for everything the help bot posts:
 * - links are kept only when they point at an allowed 6529.io origin; other
 *   Markdown links keep their label as plain text and other bare URLs are
 *   removed;
 * - group mention tokens are turned into plain words unless explicitly
 *   allowed by the caller;
 * - user mentions are kept only when the source knowledge contains them.
 */

export const HELP_BOT_GROUP_MENTION_TOKENS = MODEL_OUTPUT_GROUP_MENTION_TOKENS;

const PRODUCTION_ORIGIN = 'https://6529.io';

export function defaultHelpBotAllowedOrigins(
  baseUrl: string = HELP_BOT_BASE_URL
): string[] {
  const origins = new Set<string>([PRODUCTION_ORIGIN]);
  try {
    const baseOrigin = new URL(baseUrl).origin;
    if (baseOrigin.startsWith('https://')) {
      origins.add(baseOrigin);
    }
  } catch {
    // An unparsable base URL adds nothing to the allowlist.
  }
  return Array.from(origins);
}

export interface HelpBotOutputFilterOptions {
  /** Origins whose https links may stay clickable. */
  readonly allowedOrigins?: readonly string[];
  /** Group mention tokens (without `@`) that may stay active. */
  readonly allowedGroupMentions?: readonly string[];
  /**
   * Knowledge the reply was grounded in. User mentions that also appear in
   * this text are kept; all others become plain handles. `null` leaves user
   * mentions unchanged (used when an earlier stage already applied the rule).
   */
  readonly sourceText?: string | null;
}

export function filterHelpBotReplyText(
  text: string,
  options: HelpBotOutputFilterOptions = {}
): string {
  return filterModelOutputText(text, {
    allowedOrigins: options.allowedOrigins ?? defaultHelpBotAllowedOrigins(),
    allowedGroupMentions: options.allowedGroupMentions,
    sourceText: options.sourceText,
    alwaysAllowedHandles: [HELP_BOT_HANDLE]
  });
}
