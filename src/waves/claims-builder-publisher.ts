import { Logger } from '@/logging';
import { sqs } from '@/sqs';

const logger = Logger.get('claims-builder-publisher');

export async function enqueueClaimBuild(dropId: string): Promise<void> {
  const queueUrl = process.env.CLAIMS_BUILDER_SQS_URL;
  if (!queueUrl) {
    throw new Error('CLAIMS_BUILDER_SQS_URL is not configured');
  }

  const response = await sqs.send({
    queue: queueUrl,
    message: { drop_id: dropId }
  });

  logger.info(
    `Queued claim build for drop_id=${dropId}, messageId=${response.MessageId}`
  );
}
