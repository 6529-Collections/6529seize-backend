import { getMintSchedule } from '@/memes-calendar';
import { LaunchPlanInput, LaunchSource } from '@/drop-forge/drop-forge.plan';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';

export function standardLaunchPlan(
  claim: number,
  source: LaunchSource,
  now: number
): LaunchPlanInput {
  const calendar = getMintSchedule(claim);
  if (calendar.phases[0].start.getTime() / 1000 <= now)
    throw new LaunchSafetyError(
      'Mint calendar does not identify a future mint for this claim'
    );
  const phaseName = (index: number) => {
    const found = source.rows.find(
      (row) => row.phase.toLowerCase().replace(/\s/g, '') === `phase${index}`
    );
    if (!found)
      throw new LaunchSafetyError(`Prepared Phase ${index} is missing`);
    return found.phase;
  };
  return {
    calendar: { version: calendar.version, time_zone: calendar.timeZone },
    initialize_at: now,
    include_artist_airdrops: true,
    include_team_airdrops: true,
    phases: calendar.phases.map((phase, index) => ({
      name: phase.isPublic ? 'Public' : phaseName(index),
      start: phase.start.getTime() / 1000,
      end: phase.end.getTime() / 1000,
      price_wei: '65290000000000000',
      is_public: phase.isPublic
    }))
  };
}
