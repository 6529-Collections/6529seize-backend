import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';
import { isIdentityOnChain } from '@/identity-freeze/identity-freeze';

const mysql = require('mysql');

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

/**
 * From switch-on the help bot's credits are a 6529.io site feature, not REP:
 * REP lists, totals and breakdowns over every category leave the credit
 * category out (the empty string before). Asked for by name, the category is
 * still served, so its page and the help bot can show a balance.
 */
export function withoutHelpBotCreditsSql(alias?: string): string {
  if (!isIdentityOnChain()) return '';
  const column = alias ? `${alias}.` : '';
  return ` and not (${column}matter = 'REP' and ${column}matter_category = ${mysql.escape(
    HELP_BOT_CREDIT_CATEGORY
  )})`;
}
