import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';
import { isIdentityOnChain } from '@/identity-freeze/identity-freeze';

const mysql = require('mysql2');

/**
 * The TDH a rater's credit and a level count: TDH + xTDH, and from switch-on
 * the chain's TDH alone (xTDH is not on the chain).
 */
export function creditTdh(
  tdh: number,
  xtdh: number | null | undefined
): number {
  return isIdentityOnChain() ? tdh : tdh + (xtdh ?? 0);
}

/** creditTdh in SQL, over an identities row alias. */
export function creditTdhSql(alias: string): string {
  return isIdentityOnChain() ? `${alias}.tdh` : `${alias}.tdh + ${alias}.xtdh`;
}

const normalised = (category: string) => category.trim().toLowerCase();

/**
 * Whether a rating counts toward REP summed over every category: from
 * switch-on the help bot's credits don't. The category is matched trimmed
 * and case-blind, as the identity mirror and the export match it, and as
 * the SQL filter below does.
 */
export function countsTowardAllCategoryRep(
  matter: string,
  category: string
): boolean {
  return allCategoryRepRule()(matter, category);
}

/**
 * countsTowardAllCategoryRep with the switch-on read once, for a loop over
 * many ratings.
 */
export function allCategoryRepRule(): (
  matter: string,
  category: string
) => boolean {
  if (!isIdentityOnChain()) return () => true;
  const credits = normalised(HELP_BOT_CREDIT_CATEGORY);
  return (matter, category) =>
    !(matter === 'REP' && normalised(category) === credits);
}

/**
 * From switch-on the help bot's credits are a 6529.io site feature, not REP:
 * REP lists, totals and breakdowns over every category leave the credit
 * category out (the empty string before). Asked for by name, the category is
 * still served, so its page and the help bot can show a balance.
 */
export function withoutHelpBotCreditsSql(alias?: string): string {
  if (!isIdentityOnChain()) return '';
  const column = alias ? `${alias}.` : '';
  // matter_category is utf8_bin (bytes), so lower(trim()) compares as the
  // in-memory rule does.
  return ` and not (${column}matter = 'REP' and lower(trim(${column}matter_category)) = ${mysql.escape(
    normalised(HELP_BOT_CREDIT_CATEGORY)
  )})`;
}
