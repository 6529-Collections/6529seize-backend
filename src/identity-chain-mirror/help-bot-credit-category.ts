import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';

/**
 * Whether a REP category is the help bot's old credit category, in any case
 * or spacing. Main removed the help bot's credits and this check with them;
 * the mirror keeps it so a rating in that category is still treated as
 * 6529.io's own, as it was when this code was reviewed.
 */
export function isHelpBotCreditCategory(
  category: string | null | undefined
): boolean {
  return (
    category?.trim().toLowerCase() === HELP_BOT_CREDIT_CATEGORY.toLowerCase()
  );
}
