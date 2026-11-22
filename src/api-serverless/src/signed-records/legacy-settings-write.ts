import { NextFunction } from 'express';
import { assertLegacySettingsWrite } from '@/personal-records/personal-records.mode';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';

/**
 * Runs before every legacy personal-settings write route: 503 while the
 * settings are frozen, and 409 PERSONAL_RECORDS_REQUIRED in `primary`
 * mode, where the change must come as a signed record.
 */
export function legacySettingsWrite(
  _req: unknown,
  _res: unknown,
  next: NextFunction
): void {
  assertLegacySettingsWrite(personalRecordsStateDb).then(() => next(), next);
}
