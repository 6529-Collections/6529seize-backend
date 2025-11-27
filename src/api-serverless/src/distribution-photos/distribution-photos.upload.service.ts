import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CLOUDFRONT_LINK, DISTRIBUTION_PHOTO_TABLE } from '../../../constants';
import { CustomApiCompliantException } from '../../../exceptions';
import { sqlExecutor } from '../../../sql-executor';

interface PhotoFile {
  name: string;
  buffer: Buffer;
  mimetype: string;
}

export async function uploadPhotos(
  contract: string,
  cardId: number,
  photos: PhotoFile[]
): Promise<string[]> {
  const s3 = new S3Client({ region: 'eu-west-1' });

  const keys: string[] = [];

  await Promise.all(
    photos.map(async (p) => {
      const name = p.name;
      const key = `distribution/${process.env.NODE_ENV}/${contract}/${cardId}/${name}`;

      const uploadedImage = await s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_6529_IMAGES_BUCKET_NAME!,
          Key: key,
          Body: p.buffer,
          ContentType: p.mimetype
        })
      );

      if (uploadedImage.$metadata.httpStatusCode === 200) {
        keys.push(`${CLOUDFRONT_LINK}/${key}`);
      } else {
        throw new CustomApiCompliantException(
          500,
          `Failed to upload image: ${name}`
        );
      }
    })
  );

  return keys;
}

export async function saveDistributionPhotos(
  contract: string,
  cardId: number,
  photoUrls: string[]
): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(
    async (connectionHolder) => {
      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_PHOTO_TABLE} WHERE card_id = :cardId AND contract = :contract`,
        {
          cardId,
          contract: contract.toLowerCase()
        },
        { wrappedConnection: connectionHolder }
      );

      if (photoUrls.length === 0) {
        return;
      }

      photoUrls.sort((a, b) => a.localeCompare(b));

      const params: Record<string, any> = {};
      const placeholders = photoUrls
        .map(
          (_, index) =>
            `(:contract_${index}, :card_id_${index}, :link_${index})`
        )
        .join(', ');

      photoUrls.forEach((link, index) => {
        params[`contract_${index}`] = contract.toLowerCase();
        params[`card_id_${index}`] = cardId;
        params[`link_${index}`] = link;
      });

      const insertSql = `
        INSERT INTO ${DISTRIBUTION_PHOTO_TABLE} (contract, card_id, link)
        VALUES ${placeholders}
      `;

      await sqlExecutor.execute(insertSql, params, {
        wrappedConnection: connectionHolder
      });
    }
  );
}
