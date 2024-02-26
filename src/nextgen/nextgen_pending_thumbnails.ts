import {
  persistNextGenToken,
  fetchPendingNextgenThumbnails
} from './nextgen.db';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';
import {
  NEXTGEN_BUCKET,
  NEXTGEN_BUCKET_AWS_REGION,
  NEXTGEN_CF_BASE_PATH,
  getNextgenNetwork
} from './nextgen_constants';
import { Network } from 'alchemy-sdk';
import { listS3Objects } from './nextgen_generator';
import { S3Client } from '@aws-sdk/client-s3';

const logger = Logger.get('NEXTGEN_PENDING_THUMBNAILS');

export async function processMissingThumbnails(entityManager: EntityManager) {
  const pending = await fetchPendingNextgenThumbnails(entityManager);

  if (pending.length === 0) {
    logger.info(`[NO PENDING THUMBNAILS]`);
    return;
  }

  logger.info(`[FOUND ${pending.length} PENDING THUMBNAILS] : [PROCESSING...]`);

  const network = getNextgenNetwork();
  const networkPath = network === Network.ETH_MAINNET ? 'mainnet' : 'testnet';

  const s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });

  const iconPath = `${networkPath}/thumbnail/`;
  const allIcons = await listS3Objects(s3, iconPath);

  const thumbPath = `${networkPath}/png0.5k/`;
  const allThumbs = await listS3Objects(s3, thumbPath);

  logger.info(
    `[FOUND ${allIcons.length} ICONS] : [FOUND ${allThumbs.length} THUMBNAILS]`
  );

  for (const token of pending) {
    if (!token.icon_url && allIcons.includes(Number(token.id))) {
      const iconUrl = `${NEXTGEN_CF_BASE_PATH}/${networkPath}/thumbnail/${token.id}`;
      token.icon_url = iconUrl;
    }
    if (!token.thumbnail_url && allThumbs.includes(Number(token.id))) {
      const thumbUrl = `${NEXTGEN_CF_BASE_PATH}/${networkPath}/png0.5k/${token.id}`;
      token.thumbnail_url = thumbUrl;
    }
    await persistNextGenToken(entityManager, token);
  }

  logger.info(`[PENDING THUMBNAILS PROCESSED]`);
}
