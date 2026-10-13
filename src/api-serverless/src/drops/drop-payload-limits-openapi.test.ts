import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  DROP_ATTACHMENT_ID_MAX_LENGTH,
  DROP_MAX_ATTACHMENTS,
  DROP_MAX_MEDIA,
  DROP_MAX_METADATA_ENTRIES,
  DROP_MAX_MENTIONED_USERS,
  DROP_MAX_MENTIONED_WAVES,
  DROP_MAX_PARTS,
  DROP_MAX_REFERENCED_NFTS,
  DROP_MEDIA_MIME_TYPE_MAX_LENGTH,
  DROP_MEDIA_UPLOAD_ID_MAX_LENGTH,
  DROP_MEDIA_URL_MAX_LENGTH,
  DROP_MENTIONED_WAVE_NAME_MAX_LENGTH,
  DROP_PART_MAX_ATTACHMENTS,
  DROP_PART_MAX_MEDIA,
  DROP_REFERENCED_NFT_NAME_MAX_LENGTH,
  DROP_REFERENCED_NFT_TOKEN_MAX_LENGTH
} from '@/drops/drop-payload-limits';

interface SchemaNode {
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly description?: string;
}

type Schemas = Record<string, { properties: Record<string, SchemaNode> }>;

const schemas = (
  parse(readFileSync(resolve(__dirname, '../../openapi.yaml'), 'utf8')) as {
    components: { schemas: Schemas };
  }
).components.schemas;

function property(schema: string, field: string): SchemaNode {
  return schemas[schema].properties[field];
}

describe('drop payload limits in the OpenAPI spec', () => {
  it.each([
    ['ApiCreateWaveDropRequest', 'parts', DROP_MAX_PARTS],
    ['ApiCreateWaveDropRequest', 'metadata', DROP_MAX_METADATA_ENTRIES],
    ['ApiCreateWaveDropRequest', 'mentioned_users', DROP_MAX_MENTIONED_USERS],
    ['ApiCreateWaveDropRequest', 'mentioned_waves', DROP_MAX_MENTIONED_WAVES],
    ['ApiCreateWaveDropRequest', 'referenced_nfts', DROP_MAX_REFERENCED_NFTS],
    ['ApiCreateDropPart', 'media', DROP_PART_MAX_MEDIA],
    ['ApiCreateDropPart', 'attachments', DROP_PART_MAX_ATTACHMENTS]
  ])(
    '%s.%s documents maxItems matching the runtime cap',
    (schema, field, cap) => {
      expect(property(schema, field).maxItems).toBe(cap);
    }
  );

  it.each([
    ['ApiCreateDropMedia', 'url', DROP_MEDIA_URL_MAX_LENGTH],
    ['ApiCreateDropMedia', 'mime_type', DROP_MEDIA_MIME_TYPE_MAX_LENGTH],
    ['ApiCreateDropMedia', 'media_upload_id', DROP_MEDIA_UPLOAD_ID_MAX_LENGTH],
    [
      'ApiDropAttachmentReference',
      'attachment_id',
      DROP_ATTACHMENT_ID_MAX_LENGTH
    ],
    ['ApiDropReferencedNFT', 'token', DROP_REFERENCED_NFT_TOKEN_MAX_LENGTH],
    ['ApiDropReferencedNFT', 'name', DROP_REFERENCED_NFT_NAME_MAX_LENGTH],
    [
      'ApiCreateMentionedWave',
      'wave_name_in_content',
      DROP_MENTIONED_WAVE_NAME_MAX_LENGTH
    ]
  ])(
    '%s.%s documents maxLength matching the runtime cap',
    (schema, field, cap) => {
      expect(property(schema, field).maxLength).toBe(cap);
    }
  );

  it('documents the per-drop totals in the parts description', () => {
    const description = property('ApiCreateWaveDropRequest', 'parts')
      .description as string;

    expect(description).toContain(`at most ${DROP_MAX_PARTS} parts`);
    expect(description).toContain(`at most ${DROP_MAX_MEDIA} media items`);
    expect(description).toContain(`${DROP_MAX_ATTACHMENTS} attachments`);
  });
});
