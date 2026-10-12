import fetch from 'node-fetch';
import { LaunchPlanInput, LaunchSource } from '@/drop-forge/drop-forge.plan';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
export async function standardLaunchPlan(
  claim: number,
  source: LaunchSource,
  now: number
): Promise<LaunchPlanInput> {
  const base = process.env.DROP_FORGE_CALENDAR_BASE_URL ?? 'https://6529.io';
  const response = await fetch(
    `${base.replace(/\/$/, '')}/api/meme-calendar/${claim}`,
    { timeout: 10000, size: 65536 }
  );
  if (!response.ok) throw new LaunchSafetyError('Mint calendar is unavailable');
  const calendar = (await response.json()) as {
    mint_number: number;
    mint_start: string;
    mint_end: string;
  };
  const start = Date.parse(calendar.mint_start) / 1000;
  const end = Date.parse(calendar.mint_end) / 1000;
  if (
    calendar.mint_number !== claim ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= now ||
    end <= start
  )
    throw new LaunchSafetyError(
      'Mint calendar does not identify a future mint for this claim'
    );
  const name = (phase: number) => {
    const found = source.rows.find(
      (row) => row.phase.toLowerCase().replace(/\s/g, '') === `phase${phase}`
    );
    if (!found)
      throw new LaunchSafetyError(`Prepared Phase ${phase} is missing`);
    return found.phase;
  };
  const phase = (
    name: string,
    begin: number,
    finish: number,
    is_public = false
  ) => ({
    name,
    start: begin,
    end: finish,
    price_wei: '65290000000000000',
    is_public
  });
  return {
    initialize_at: now,
    include_artist_airdrops: true,
    include_team_airdrops: true,
    phases: [
      phase(name(0), start, start + 2400),
      phase(name(1), start + 3000, start + 4200),
      phase(name(2), start + 4800, start + 6000),
      phase('Public', start + 6000, end, true)
    ]
  };
}
