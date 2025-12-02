import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CLOUDFRONT_LINK } from '../../../constants';
import { CustomApiCompliantException } from '../../../exceptions';

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
