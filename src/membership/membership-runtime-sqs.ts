import { performance } from 'node:perf_hooks';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Logger } from '@/logging';
import { MembershipRefreshTargetKey } from './membership-validation';
import { MembershipDeliveryDescriptor } from './membership-worker.types';
import {
  MembershipRuntimeDeployment,
  validateMembershipRuntimeHint
} from './membership-runtime-policy';

export interface MembershipQueueCredentials {
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  readonly sessionToken: string | undefined;
}

export interface MembershipQueueSendContext {
  readonly deadline_monotonic_millis: number;
  readonly signal: AbortSignal;
}

/** A dedicated client uses deployment identity and credentials captured before secrets. */
export function createMembershipQueueSender(
  runtime: MembershipRuntimeDeployment,
  credentials: MembershipQueueCredentials,
  correlation: { request_id: string; event_id: string },
  logger: Logger
) {
  if (
    runtime.mode !== 'staging-fixture-v1' ||
    !credentials.accessKeyId ||
    !credentials.secretAccessKey ||
    !credentials.sessionToken
  )
    throw new Error(
      'Membership queue sender requires its deployment credentials'
    );
  const client = new SQSClient({
    region: runtime.region,
    // SDK annotates its private credential object with signing-source metadata.
    // Copy the frozen cold-start snapshot without consulting mutable environment.
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 500,
      socketTimeout: 1000,
      requestTimeout: 1500,
      throwOnRequestTimeout: true
    })
  });
  return {
    async send(
      value: {
        target: MembershipRefreshTargetKey;
        delivery: MembershipDeliveryDescriptor;
      },
      context: MembershipQueueSendContext
    ): Promise<void> {
      const hint = validateMembershipRuntimeHint({
        protocol_version: 1,
        ...value
      });
      if (
        context.signal.aborted ||
        !Number.isFinite(context.deadline_monotonic_millis) ||
        performance.now() >= context.deadline_monotonic_millis
      )
        throw new Error('Membership send deadline exhausted');
      const response = await client.send(
        new SendMessageCommand({
          QueueUrl: runtime.queue_url,
          MessageBody: JSON.stringify(hint),
          MessageAttributes: {
            MembershipDispatcherRequestId: {
              DataType: 'String',
              StringValue: correlation.request_id
            },
            MembershipDispatcherEventId: {
              DataType: 'String',
              StringValue: correlation.event_id
            }
          }
        }),
        { abortSignal: context.signal }
      );
      if (!response.MessageId)
        throw new Error(
          'Membership send acknowledgement has no message identity'
        );
      logger.info(
        JSON.stringify({
          event: 'membership_dispatch_send',
          ...correlation,
          message_id: response.MessageId,
          target: hint.target,
          delivery: hint.delivery,
          acknowledged_after_deadline:
            performance.now() >= context.deadline_monotonic_millis
        })
      );
      if (
        context.signal.aborted ||
        performance.now() >= context.deadline_monotonic_millis
      )
        throw new Error(
          'Membership send acknowledgement arrived after deadline'
        );
    },
    close: () => client.destroy()
  };
}
