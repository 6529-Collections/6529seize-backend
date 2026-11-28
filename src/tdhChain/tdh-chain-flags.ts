import { reloadSecretKeys } from '@/env';
import { Logger } from '@/logging';

const logger = Logger.get('TDH_CHAIN_FLAGS');

/**
 * The settings of the TDH chain switch. They are read from the secret again
 * on every invocation of the Lambdas that act on them (tdhLoop,
 * delegationsLoop, tdhHistoryLoop), so turning a flag off takes effect at
 * the next invocation, warm containers included, with no redeploy.
 */
export const TDH_CHAIN_SETTING_KEYS = [
  'FEATURE_TDH_CHAIN_SHADOW',
  'FEATURE_TDH_FROM_CHAIN',
  'TDH_CHAIN_GATEWAY_URL'
] as const;

/**
 * Reads the settings again. If the secret can't be read, the values the
 * container already has stay, and a warning says so.
 */
export async function refreshTdhChainSettings(
  reload: (keys: readonly string[]) => Promise<void> = reloadSecretKeys
): Promise<void> {
  try {
    await reload(TDH_CHAIN_SETTING_KEYS);
  } catch (e) {
    logger.warn(
      `[COULD NOT READ THE TDH CHAIN SETTINGS AGAIN] [KEEPING THE LOADED VALUES] [${(e as Error).message}]`
    );
  }
}
