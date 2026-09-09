import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { assetError } from '@/artwork-documentation/assets/artwork-assets.policy';

let s3: S3Client;
export function artworkArchiveRegion(): string {
  return (
    process.env.ARTWORK_DOCUMENTATION_S3_REGION ??
    process.env.AWS_REGION ??
    'eu-west-1'
  );
}
export function artworkArchiveBucket(): string {
  const explicit = process.env.ARTWORK_DOCUMENTATION_S3_BUCKET;
  if (explicit) return explicit;
  const region = artworkArchiveRegion();
  // The two release environments use separate regions and private stacks.
  if (!['eu-west-1', 'us-east-1'].includes(region))
    assetError(503, 'ASSET_STORAGE_UNAVAILABLE');
  return `6529-artwork-documentation-987989283142-${region}`;
}
export function getArtworkArchiveS3(): S3Client {
  s3 ??= new S3Client({
    region: artworkArchiveRegion(),
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000,
      socketTimeout: 60_000
    })
  });
  return s3;
}
