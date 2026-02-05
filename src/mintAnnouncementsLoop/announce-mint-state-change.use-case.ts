import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { DeployerDropper, deployerDropper } from '@/deployer-dropper';
import { Env, env } from '@/env';
import {
  ManifoldClaimService,
  manifoldClaimService
} from './manifold-claim.service';

interface PhaseConfig {
  readonly name: string;
  readonly startHour: number;
  readonly startMinute: number;
  readonly closesAt: string;
}

const PHASES: readonly PhaseConfig[] = [
  { name: 'Phase0', startHour: 17, startMinute: 40, closesAt: '18:20' },
  { name: 'Phase1', startHour: 18, startMinute: 30, closesAt: '18:50' },
  { name: 'Phase2', startHour: 19, startMinute: 0, closesAt: '19:20' },
  {
    name: 'Public Phase',
    startHour: 19,
    startMinute: 20,
    closesAt: 'tomorrow at 17:00'
  }
];

const MAX_MINUTES_AFTER_PHASE_START = Time.minutes(5);

export class AnnounceMintStateChangeUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly deployerDropper: DeployerDropper,
    private readonly manifoldClaimService: ManifoldClaimService,
    private readonly env: Env
  ) {}

  async handle(ctx: RequestContext): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->handle`);
      const currentPhase = this.findCurrentPhase();

      if (!currentPhase) {
        this.logger.info(
          'No active phase found within the allowed time window'
        );
        return;
      }

      const remainingEditions =
        await this.manifoldClaimService.getRemainingEditionsForLatestMeme(ctx);
      const waves = this.env.getStringArray('DEPLOYER_ANNOUNCEMENTS_WAVE_IDS');
      const message =
        remainingEditions > 0
          ? `${currentPhase.name} is live, ${remainingEditions} remaining editions, this phase closes at ${currentPhase.closesAt} UTC`
          : 'Mint Complete';

      this.logger.info(message);
      await this.deployerDropper.drop({ message, waves }, ctx);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }

  private findCurrentPhase(): PhaseConfig | null {
    const todayMidnightUtc = Time.todayUtcMidnight();
    let matchedPhase: PhaseConfig | null = null;
    let smallestDiff: Time | null = null;
    const now = Time.now();
    for (const phase of PHASES) {
      const phaseStart = todayMidnightUtc
        .plusHours(phase.startHour)
        .plusMinutes(phase.startMinute);

      const timeSincePhaseStart = now.minus(phaseStart);

      if (
        now.gte(phaseStart) &&
        timeSincePhaseStart.lt(MAX_MINUTES_AFTER_PHASE_START)
      ) {
        if (smallestDiff === null || timeSincePhaseStart.lt(smallestDiff)) {
          smallestDiff = timeSincePhaseStart;
          matchedPhase = phase;
        }
      }
    }

    return matchedPhase;
  }
}

export const announceMintStateChangeUseCase =
  new AnnounceMintStateChangeUseCase(
    deployerDropper,
    manifoldClaimService,
    env
  );
