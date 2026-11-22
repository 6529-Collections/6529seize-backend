import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import type { PersonalSwitchState } from './personal-records-state.db';

/**
 * Where personal settings are written (env PERSONAL_RECORDS_MODE, a Lambda
 * environment variable of the API):
 * - `legacy` (default): the settings routes write the tables, as today;
 *   POST /signed-records refuses.
 * - `shadow`: the routes still write the tables; clients also send the same
 *   change as signed records, marked as companions, which are checked and
 *   logged, not applied.
 * - `primary`: signed records are the only write; the appliers write the
 *   tables and the settings routes answer 409 PERSONAL_RECORDS_REQUIRED.
 * Rollback from `primary` is `shadow`.
 */
export type PersonalRecordsMode = 'legacy' | 'shadow' | 'primary';

const MODES: readonly PersonalRecordsMode[] = ['legacy', 'shadow', 'primary'];

type Env = Readonly<Record<string, string | undefined>>;

const logger = Logger.get('PERSONAL_RECORDS_MODE');
let warnedAbout: string | null = null;

export function personalRecordsMode(
  env: Env = process.env
): PersonalRecordsMode {
  const raw = env.PERSONAL_RECORDS_MODE?.trim().toLowerCase();
  const mode = MODES.find((it) => it === raw);
  if (!mode && raw && warnedAbout !== raw) {
    // A mistyped mode must not pass silently: it means legacy, loudly.
    warnedAbout = raw;
    logger.error(
      `[PERSONAL RECORDS MODE] unknown value "${raw}"; using legacy`
    );
  }
  return mode ?? 'legacy';
}

/** The freeze, from the shared switch state (personal_records_state). */
export interface SwitchStateSource {
  read(): Promise<PersonalSwitchState>;
}

/** 503 while the personal settings switch has them frozen. */
export async function assertNotFrozen(state: SwitchStateSource): Promise<void> {
  if ((await state.read()).frozen) {
    throw new CustomApiCompliantException(
      503,
      'Settings are paused for a few minutes while they move. Try again shortly.',
      'PERSONAL_SETTINGS_PAUSED'
    );
  }
}

/**
 * Called first by every legacy personal-settings write route: refuses while
 * the settings are frozen, and in `primary` mode, where the change must
 * come as a signed record.
 */
export async function assertLegacySettingsWrite(
  state: SwitchStateSource,
  env: Env = process.env
): Promise<void> {
  await assertNotFrozen(state);
  if (personalRecordsMode(env) === 'primary') {
    throw new CustomApiCompliantException(
      409,
      'This setting is now saved as a signed record. Reload the page and try again.',
      'PERSONAL_RECORDS_REQUIRED'
    );
  }
}

/**
 * Called by POST /signed-records: refuses while frozen and in `legacy`
 * mode, and in `shadow` mode takes only companions of a legacy write, so a
 * client that thinks it is in `primary` never sees a record "saved" that
 * no table holds.
 */
export async function assertRecordsWrite(
  state: SwitchStateSource,
  companion: boolean,
  env: Env = process.env
): Promise<Exclude<PersonalRecordsMode, 'legacy'>> {
  await assertNotFrozen(state);
  const mode = personalRecordsMode(env);
  if (mode === 'legacy') {
    throw new CustomApiCompliantException(
      409,
      'Settings are not saved as signed records yet.',
      'PERSONAL_RECORDS_OFF'
    );
  }
  if (mode === 'shadow' && !companion) {
    throw new CustomApiCompliantException(
      409,
      "Settings are saved with today's request for now. Reload the page and try again.",
      'PERSONAL_RECORDS_SHADOW'
    );
  }
  return mode;
}
