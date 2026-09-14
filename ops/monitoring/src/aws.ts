import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { Alert, hash } from './contract.js';
import type { Group, Store, Work } from './pipeline.js';
import { DeliveryError } from './webhook.js';

export function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_SETTING_${name}`);
  return value;
}
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true } }
);
export const sqs = new SQSClient({ maxAttempts: 3 });
const secrets = new SecretsManagerClient({ maxAttempts: 3 });
const s3 = new S3Client({ maxAttempts: 3 });
const sns = new SNSClient({ maxAttempts: 3 });
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const expiry = (): number => nowSeconds() + 45 * 86400;
const conditional = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';
function duplicateGroupWrite(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== 'TransactionCanceledException'
  )
    return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] })
    .CancellationReasons;
  // The first item guards receipt.groupKey; the second increments the group count.
  // Missing reasons, conflicts, capacity errors or a failed count update must retry.
  return (
    Array.isArray(reasons) &&
    reasons.length === 2 &&
    reasons[0]?.Code === 'ConditionalCheckFailed' &&
    reasons[1]?.Code === 'None'
  );
}
export async function read(
  pk: string
): Promise<Record<string, unknown> | undefined> {
  return (
    await ddb.send(
      new GetCommand({
        TableName: setting('RECEIPTS_TABLE'),
        Key: { pk },
        ConsistentRead: true
      })
    )
  ).Item;
}
export async function put(
  pk: string,
  values: Record<string, unknown>
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: setting('RECEIPTS_TABLE'),
      Item: { pk, expiresAt: expiry(), ...values }
    })
  );
}
export const store: Store = {
  async reserve(id, owner, now) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: setting('RECEIPTS_TABLE'),
          Key: { pk: `receipt:${id}` },
          UpdateExpression:
            'SET leaseOwner = :owner, leaseUntil = :until, expiresAt = :expiry',
          ConditionExpression:
            'attribute_not_exists(outcome) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
          ExpressionAttributeValues: {
            ':owner': owner,
            ':until': now + 90,
            ':expiry': expiry(),
            ':now': now
          }
        })
      );
      return 'acquired';
    } catch (error) {
      if (!conditional(error)) throw error;
      return (await read(`receipt:${id}`))?.outcome ? 'done' : 'busy';
    }
  },
  async complete(id, owner, outcome) {
    await ddb.send(
      new UpdateCommand({
        TableName: setting('RECEIPTS_TABLE'),
        Key: { pk: `receipt:${id}` },
        UpdateExpression:
          'SET outcome = :outcome REMOVE leaseOwner, leaseUntil',
        ConditionExpression: 'leaseOwner = :owner',
        ExpressionAttributeValues: { ':outcome': outcome, ':owner': owner }
      })
    );
  },
  async release(id, owner) {
    await ddb
      .send(
        new UpdateCommand({
          TableName: setting('RECEIPTS_TABLE'),
          Key: { pk: `receipt:${id}` },
          UpdateExpression: 'REMOVE leaseOwner, leaseUntil',
          ConditionExpression: 'leaseOwner = :owner',
          ExpressionAttributeValues: { ':owner': owner }
        })
      )
      .catch((error) => {
        if (!conditional(error)) throw error;
      });
  },
  async group(key, id, alert) {
    // Each event is counted once even when delivery/scheduling retries. A retry keeps its original bucket.
    const receipt = await read(`receipt:${id}`);
    let effectiveKey =
      typeof receipt?.groupKey === 'string' ? receipt.groupKey : key;
    if (!receipt?.groupKey) {
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: setting('RECEIPTS_TABLE'),
                  Key: { pk: `receipt:${id}` },
                  UpdateExpression: 'SET groupKey = :key',
                  ConditionExpression: 'attribute_not_exists(groupKey)',
                  ExpressionAttributeValues: { ':key': key }
                }
              },
              {
                Update: {
                  TableName: setting('RECEIPTS_TABLE'),
                  Key: { pk: key },
                  UpdateExpression:
                    'SET firstEventId = if_not_exists(firstEventId, :id), alert = if_not_exists(alert, :alert), expiresAt = :expiry ADD #count :one',
                  ExpressionAttributeNames: { '#count': 'count' },
                  ExpressionAttributeValues: {
                    ':id': id,
                    ':alert': alert,
                    ':expiry': expiry(),
                    ':one': 1
                  }
                }
              }
            ]
          })
        );
      } catch (error) {
        if (!duplicateGroupWrite(error)) throw error;
        const persisted = await read(`receipt:${id}`);
        if (typeof persisted?.groupKey !== 'string' || !persisted.groupKey)
          throw error;
        effectiveKey = persisted.groupKey;
      }
    }
    const group = await store.readGroup(effectiveKey);
    if (!group) throw new Error('GROUP_NOT_PERSISTED');
    return group;
  },
  async readGroup(key) {
    const item = await read(key);
    return item ? ({ ...item, key } as unknown as Group) : null;
  },
  async heartbeat(lane, now) {
    await put(`health:${lane}`, { seenAt: now });
  }
};
export async function enqueue(
  work: Work,
  critical = false,
  delay = 0
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: setting(critical ? 'CRITICAL_QUEUE_URL' : 'NORMAL_QUEUE_URL'),
      MessageBody: JSON.stringify(work),
      DelaySeconds: Math.max(0, Math.min(900, delay))
    })
  );
}
export async function archive(value: unknown, reason: string): Promise<void> {
  const body = JSON.stringify({
    reason,
    recordedAt: new Date().toISOString(),
    work: value
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: setting('ARCHIVE_BUCKET'),
      Key: `${new Date().toISOString().slice(0, 10)}/${hash(body)}.json`,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256'
    })
  );
}
const secretCache = new Map<string, { value: string; until: number }>();
export async function secret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);
  if (cached && cached.until > Date.now()) return cached.value;
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: arn })
  );
  if (!result.SecretString) throw new Error('SECRET_UNAVAILABLE');
  secretCache.set(arn, {
    value: result.SecretString,
    until: Date.now() + 60000
  });
  return result.SecretString;
}
export async function backup(code: string): Promise<void> {
  await sns.send(
    new PublishCommand({
      TopicArn: setting('FALLBACK_TOPIC_ARN'),
      Subject: '6529 monitoring needs attention',
      Message: `Monitoring event ${code}. Inspect monitoring alarms, queues and archive. No application data is included.`
    })
  );
}
export async function normalDeliverySlot(): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: setting('RECEIPTS_TABLE'),
        Key: { pk: 'delivery-rate:normal' },
        UpdateExpression: 'SET nextSendAt = :next, expiresAt = :expiry',
        ConditionExpression:
          'attribute_not_exists(nextSendAt) OR nextSendAt <= :now',
        ExpressionAttributeValues: {
          ':now': Date.now(),
          ':next': Date.now() + 2000,
          ':expiry': expiry()
        }
      })
    );
  } catch (error) {
    if (!conditional(error)) throw error;
    // Leave capacity in the shared vendor bucket for the critical lane.
    throw new DeliveryError(true, 3, true);
  }
}

export async function admit(alert: Alert): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60000);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: setting('RECEIPTS_TABLE'),
        Key: { pk: `quota:${alert.environment}:${alert.service}:${minute}` },
        UpdateExpression: 'SET expiresAt = :expiry ADD #count :one',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':expiry': expiry(),
          ':one': 1,
          ':limit': Number(process.env.EVENTS_PER_SERVICE_MINUTE ?? 120)
        }
      })
    );
    return true;
  } catch (error) {
    if (!conditional(error)) throw error;
    return false;
  }
}
