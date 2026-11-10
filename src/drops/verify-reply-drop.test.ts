import fc from 'fast-check';
import { DropType } from '@/entities/IDrop';
import { BadRequestException } from '@/exceptions';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';

type ReplyTargetEntity = { id: string; wave_id: string; parts_count: number };

function createUseCase(replyTargets: ReplyTargetEntity[]) {
  const dropsDb = {
    getDropsByIds: jest.fn(async (ids: string[]) =>
      replyTargets.filter((drop) => ids.includes(drop.id))
    )
  };
  return new CreateOrUpdateDropUseCase(
    dropsDb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      evaluate: jest.fn(),
      assertPostingAllowed: jest.fn()
    }
  );
}

async function verifyReply(
  useCase: CreateOrUpdateDropUseCase,
  replyTo: { drop_id: string; drop_part_id: number }
): Promise<void> {
  await (useCase as any).verifyReplyDrop(
    {
      drop_type: DropType.CHAT,
      wave_id: 'target-wave',
      reply_to: replyTo
    },
    { connection: {} }
  );
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as Error).message;
}

describe('CreateOrUpdateDropUseCase.verifyReplyDrop', () => {
  it('accepts a reply to an existing part in the same wave', async () => {
    const useCase = createUseCase([
      { id: 'target', wave_id: 'target-wave', parts_count: 2 }
    ]);

    await expect(
      verifyReply(useCase, { drop_id: 'target', drop_part_id: 2 })
    ).resolves.toBeUndefined();
  });

  it('returns the same response for missing targets and targets in another wave', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('missing', 'other-wave', 'out-of-range'),
        async (scenario) => {
          const useCase = createUseCase([
            { id: 'elsewhere', wave_id: 'other-wave', parts_count: 1 },
            { id: 'short', wave_id: 'target-wave', parts_count: 1 }
          ]);
          const replyTargets: Record<
            typeof scenario,
            { drop_id: string; drop_part_id: number }
          > = {
            missing: { drop_id: 'target', drop_part_id: 1 },
            'other-wave': { drop_id: 'elsewhere', drop_part_id: 1 },
            'out-of-range': { drop_id: 'short', drop_part_id: 2 }
          };
          const replyTo = replyTargets[scenario];

          const message = await rejectionMessage(verifyReply(useCase, replyTo));

          expect(message).toBe(
            `Invalid reply target: ${replyTo.drop_id}/${replyTo.drop_part_id}`
          );
        }
      )
    );
  });
});
