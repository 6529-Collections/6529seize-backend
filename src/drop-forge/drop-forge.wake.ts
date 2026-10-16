import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Logger } from '@/logging';
const logger = Logger.get('DROP_FORGE_WAKE');
export async function wakeDropForge(preparation = false): Promise<void> {
  const name = preparation ? 'dropForgePreparationLoop' : 'dropForgeLaunchLoop';
  try {
    await new LambdaClient({}).send(
      new InvokeCommand({
        FunctionName: name,
        InvocationType: 'Event',
        Payload: Buffer.from('{}')
      })
    );
  } catch {
    logger.warn(
      `${name} immediate wake deferred; durable work remains eligible for scheduled recovery`
    );
  }
}
