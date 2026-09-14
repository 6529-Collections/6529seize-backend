import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from '@/api/auth/auth';
import { BadRequestException } from '@/exceptions';
import { ChatHistoryPurgeScope } from '@/drops/chat-history-purge.db';

function signature(payload: string): Buffer {
  return createHmac('sha256', getJwtSecret())
    .update(`wave-chat-history-purge-v1:${payload}`)
    .digest();
}

export function createChatHistoryPurgeToken(
  scope: ChatHistoryPurgeScope
): string {
  const payload = Buffer.from(JSON.stringify(scope)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function readChatHistoryPurgeToken(
  token: string,
  expected: { waveId: string; authorId: string }
): number {
  try {
    const [payload, encodedSignature, extra] = token.split('.');
    if (
      !payload ||
      !encodedSignature ||
      extra !== undefined ||
      token.length > 2048
    )
      throw new Error('Malformed token');
    const actual = Buffer.from(encodedSignature, 'base64url');
    const wanted = signature(payload);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
      throw new Error('Invalid signature');
    const scope: ChatHistoryPurgeScope = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    if (
      scope.authorId !== expected.authorId ||
      scope.waveId !== expected.waveId ||
      !Number.isSafeInteger(scope.cutoffSerialNo) ||
      scope.cutoffSerialNo < 0
    )
      throw new Error('Invalid scope');
    return scope.cutoffSerialNo;
  } catch {
    throw new BadRequestException('Invalid chat history purge token');
  }
}
