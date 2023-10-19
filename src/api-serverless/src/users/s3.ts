import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

let sharp: any;
if (process.env.NODE_ENV == 'local') {
  sharp = require('sharp');
} else {
  sharp = require(__dirname + '/native_modules/sharp');
}

const TARGET_HEIGHT = 500;

let s3: S3Client;

export const scalePfpAndPersistToS3 = async (
  file: any,
  fileExtension: string
) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  const keyExtension: string = fileExtension !== '.gif' ? 'webp' : 'gif';

  const scaledBuffer = await resizeImage(keyExtension, file);

  const key = `pfp/${process.env.NODE_ENV}/${randomUUID()}.${keyExtension}`;

  const uploadedScaledImage = await s3.send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: key,
      Body: scaledBuffer,
      ContentType: `image/${keyExtension}`
    })
  );
  if (uploadedScaledImage.$metadata.httpStatusCode == 200) {
    return `https://6529bucket.s3.eu-west-1.amazonaws.com/${key}?d=${Date.now()}`;
  }
  throw new Error('Failed to upload image');
};

async function resizeImage(ext: string, file: any) {
  const buffer = file.buffer;
  if (ext != 'gif') {
    return await sharp(buffer)
      .resize({ height: TARGET_HEIGHT })
      .webp()
      .toBuffer();
  } else {
    return await sharp(buffer, { animated: true })
      .resize({ height: TARGET_HEIGHT })
      .toBuffer();
  }
}
