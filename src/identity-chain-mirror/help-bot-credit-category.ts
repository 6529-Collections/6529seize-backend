import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';

/**
 * Whether a REP category is the help bot's old credit category, in any case
 * or spacing. Main removed the help bot's credits and this check with them.
 * The mirror keeps it for now, so a rating in that category stays 6529.io's
 * own and the mirror neither writes nor removes it: the help bot's ratings
 * in it are deleted by main's REP removal job, and the category is empty
 * from then on. Dropping the check is a follow-up together with switch-on's
 * matching credit rule (src/rates/rating-credit.ts).
 */
export function isHelpBotCreditCategory(
  category: string | null | undefined
): boolean {
  return (
    category?.trim().toLowerCase() === HELP_BOT_CREDIT_CATEGORY.toLowerCase()
  );
}
