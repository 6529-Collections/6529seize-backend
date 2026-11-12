import * as Joi from 'joi';
import { BadRequestException } from '@/exceptions';
import { getValidatedByJoiOrThrow } from '@/api/validation';

export const MAX_DIRECT_MESSAGE_IDENTITY_ADDRESSES = 100;

const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export interface DirectMessageWaveRequest {
  readonly identity_addresses: string[];
}

export const DirectMessageWaveRequestSchema =
  Joi.object<DirectMessageWaveRequest>({
    identity_addresses: Joi.array()
      .items(Joi.string().pattern(WALLET_ADDRESS_PATTERN).required())
      .min(1)
      .max(MAX_DIRECT_MESSAGE_IDENTITY_ADDRESSES)
      .required()
  });

/**
 * Validates a direct-message wave request and returns the recipient addresses
 * lowercased and de-duplicated. The creator's own wallets are not allowed as
 * recipients.
 */
export function getValidatedDirectMessageRecipientAddresses(
  body: unknown,
  creatorWallets: readonly string[]
): string[] {
  const request = getValidatedByJoiOrThrow(
    body,
    DirectMessageWaveRequestSchema
  );
  const recipients = Array.from(
    new Set(request.identity_addresses.map((it) => it.toLowerCase()))
  );
  const ownWallets = new Set(creatorWallets.map((it) => it.toLowerCase()));
  if (recipients.some((it) => ownWallets.has(it))) {
    throw new BadRequestException(`You cannot DM yourself.`);
  }
  return recipients;
}
