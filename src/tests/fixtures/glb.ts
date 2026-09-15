export const JSON_CHUNK_TYPE = 0x4e4f534a;
export const BIN_CHUNK_TYPE = 0x004e4942;
const DEFAULT_GLB_JSON = { asset: { version: '2.0' } } as const;

export function glbChunk(type: number, data: Buffer): Buffer {
  const padding = (4 - (data.length % 4)) % 4;
  const chunk = Buffer.alloc(
    8 + data.length + padding,
    type === JSON_CHUNK_TYPE ? 0x20 : 0
  );
  chunk.writeUInt32LE(data.length + padding, 0);
  chunk.writeUInt32LE(type, 4);
  data.copy(chunk, 8);
  return chunk;
}

export function glbFromChunks(chunks: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(
    12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    8
  );
  return Buffer.concat([header, ...chunks]);
}

export function validGlb(
  json: unknown = DEFAULT_GLB_JSON,
  binary?: Buffer
): Buffer {
  const chunks = [glbChunk(JSON_CHUNK_TYPE, Buffer.from(JSON.stringify(json)))];
  if (binary !== undefined) chunks.push(glbChunk(BIN_CHUNK_TYPE, binary));
  return glbFromChunks(chunks);
}
