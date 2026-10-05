import * as Joi from 'joi';
import { CompetitionCapability } from '@/entities/ICompetition';
import { competitionCapabilityService } from './competition-capability.service';

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'competition:capability --wave <id> --competition <uuid> --capability MAIN_STAGE|CURATION|QUORUM|ANNOUNCEMENTS --action assign|remove --actor <profile-id> --reason <text> --idempotency-key <uuid> [--live]\nDefaults to a read-only dry run. Requires an allowlisted operator who administers the wave.\n'
    );
    return;
  }
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live') parsed.live = true;
    else if (
      arg.startsWith('--') &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      parsed[arg.slice(2)] = args[++index];
    else throw new Error('Invalid arguments; use --help');
  }
  const result = Joi.object({
    wave: Joi.string().max(100).required(),
    competition: Joi.string().uuid().required(),
    capability: Joi.string()
      .valid(...Object.values(CompetitionCapability))
      .required(),
    action: Joi.string().valid('assign', 'remove').required(),
    actor: Joi.string().max(100).required(),
    reason: Joi.string().min(1).max(2000).required(),
    'idempotency-key': Joi.string().uuid().required(),
    live: Joi.boolean().default(false)
  }).validate(parsed);
  if (result.error) throw new Error(result.error.message);
  const options = result.value;
  const { doInDbContext } = await import('@/secrets');
  const response = await doInDbContext(
    () =>
      competitionCapabilityService.change(
        {
          waveId: options.wave,
          competitionId: options.competition,
          capability: options.capability,
          action: options.action,
          actorId: options.actor,
          reason: options.reason
        },
        options['idempotency-key'],
        !options.live,
        {}
      ),
    { syncEntities: false, skipRedis: false }
  );
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Capability operation failed'}\n`
    );
    process.exitCode = 1;
  });
