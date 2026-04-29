import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

let attachmentsS3: S3Client;

export function getAttachmentsS3() {
  if (!attachmentsS3) {
    attachmentsS3 = new S3Client({
      region:
        process.env.ATTACHMENTS_INGEST_S3_REGION ??
        process.env.AWS_REGION ??
        process.env.S3_REGION ??
        'eu-west-1',
      requestHandler: new NodeHttpHandler({
        socketTimeout: 300_000 // 5 minutes
      })
    });
  }
  return attachmentsS3;
}
