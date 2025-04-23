import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

let s3: S3Client;

export function getS3() {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.S3_REGION ?? 'eu-west-1',
      requestHandler: new NodeHttpHandler({
        socketTimeout: 300_000 // 5 minutes
      })
    });
  }
  return s3;
}
