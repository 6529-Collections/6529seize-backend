import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const imagescript = require('imagescript');

let sharp: any;
if (process.env.NODE_ENV == 'local') {
  sharp = require('sharp');
} else {
  sharp = require(__dirname + '/native_modules/sharp');
}

const TARGET_HEIGHT = 500;

let s3: S3Client;

export const persistS3 = async (
  wallet: string,
  file: any,
  fileExtension: string
) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  const myBucket = process.env.AWS_IMAGES_BUCKET_NAME!;

  console.log(
    '[S3]',
    `[PROCESSING PFP FOR ${wallet}]`,
    `[EXTENSION ${fileExtension}]`
  );

  let keyExtension: string;
  if (fileExtension != '.gif') {
    keyExtension = 'webp';
  } else {
    keyExtension = 'gif';
  }

  const scaledBuffer = await resizeImage(wallet, keyExtension, file);

  const key = `pfp/${process.env.NODE_ENV}/${wallet}.${keyExtension}`;

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
  return null;
};

async function resizeImage(wallet: string, ext: string, file: any) {
  try {
    const buffer = file.buffer;

    if (ext != 'gif') {
      return await sharp(buffer)
        .resize({ height: TARGET_HEIGHT })
        .webp()
        .toBuffer();
    } else {
      const gif = await imagescript.GIF.decode(buffer);
      const scaleFactor = gif.height / TARGET_HEIGHT;
      gif.resize(gif.width / scaleFactor, TARGET_HEIGHT);
      return gif.encode();
    }
  } catch (err: any) {
    console.log(`[RESIZING FOR ${wallet}]`, `[FAILED!]`, `[${err}]`);
  }
}
