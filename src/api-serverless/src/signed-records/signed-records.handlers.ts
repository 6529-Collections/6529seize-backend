import { ApiSignedRecordsAnchor } from '@/api/generated/models/ApiSignedRecordsAnchor';
import { ApiSignedRecordsOwners } from '@/api/generated/models/ApiSignedRecordsOwners';
import {
  GetSignedRecordsAnchorRequest,
  GetSignedRecordsOwnersRequest
} from '@/api/generated/routes/operations';
import { BadRequestException } from '@/exceptions';
import {
  RecordAnchorService,
  recordAnchorService
} from '@/signed-records/record-anchor';
import { isWalletAddress } from '@/signed-records/record-families';
import { recordOwnerDirectory } from '@/signed-records/record-owner-directory';

/** GET /signed-records/anchor: the height to sign as a record's anchor. */
export async function handleGetSignedRecordsAnchor(
  _req: GetSignedRecordsAnchorRequest,
  service: RecordAnchorService = recordAnchorService
): Promise<ApiSignedRecordsAnchor> {
  const anchor = await service.getAnchor();
  return {
    anchor: anchor.anchor,
    head_height: anchor.headHeight,
    finalized_time: anchor.finalizedTime,
    max_anchor_lag: anchor.maxAnchorLag
  };
}

const OWNERS_MAX_WALLETS = 50;

/** GET /signed-records/owners: the owner each wallet's records use. */
export async function handleGetSignedRecordsOwners(
  req: GetSignedRecordsOwnersRequest
): Promise<ApiSignedRecordsOwners> {
  const wallets = Array.from(
    new Set(
      String(req.query.wallets ?? '')
        .split(',')
        .map((wallet) => wallet.trim().toLowerCase())
        .filter((wallet) => wallet.length > 0)
    )
  );
  if (
    wallets.length === 0 ||
    wallets.length > OWNERS_MAX_WALLETS ||
    wallets.some((wallet) => !isWalletAddress(wallet))
  ) {
    throw new BadRequestException(
      `Send 1 to ${OWNERS_MAX_WALLETS} wallets, 0x and 40 hex digits each`
    );
  }
  const { anchor } = await recordAnchorService.getAnchor();
  const owners = await Promise.all(
    wallets.map(async (wallet) => ({
      wallet,
      owner: await recordOwnerDirectory.ownerAt(wallet, anchor)
    }))
  );
  return { anchor, owners };
}
