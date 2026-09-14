import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, RequestHandler } from 'express';
import { initMulterSingleMiddleware } from '@/api/multer-middleware';

const boundary = '6529-multipart-regression';
function part(name: string, bytes: Buffer, filename?: string): Buffer {
  const fileHeaders = filename
    ? `; filename="${filename}"\r\nContent-Type: ${filename.endsWith('.csv') ? 'text/csv' : 'image/png'}`
    : '';
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${fileHeaders}\r\n\r\n`
    ),
    bytes,
    Buffer.from('\r\n')
  ]);
}

async function parse(field: string, parts: Buffer[], terminate = true) {
  const body = Buffer.concat([
    ...parts,
    ...(terminate ? [Buffer.from(`--${boundary}--\r\n`)] : [])
  ]);
  const request = Readable.from([
    body.subarray(0, 9),
    body.subarray(9)
  ]) as unknown as Request;
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length)
  };
  request.method = 'POST';
  const middleware: RequestHandler = initMulterSingleMiddleware(field);
  await new Promise<void>((resolve, reject) => {
    middleware(request, {} as Response, (error) =>
      error ? reject(error) : resolve()
    );
  });
  return request;
}

describe('production multipart middleware', () => {
  it.each(['pfp', 'allowlist'])(
    'preserves memory-backed %s uploads and text fields',
    async (field) => {
      const bytes =
        field === 'pfp'
          ? readFileSync(join(__dirname, '../../../scripts/media-fixtures/png'))
          : Buffer.from(
              'address,amount\n0x0000000000000000000000000000000000000001,1\n'
            );
      const filename = field === 'pfp' ? 'fixture.png' : 'fixture.csv';
      const request = await parse(field, [
        part('label', Buffer.from('fixture')),
        part(field, bytes, filename)
      ]);
      expect(request.body.label).toBe('fixture');
      expect(request.file).toMatchObject({
        fieldname: field,
        originalname: filename,
        size: bytes.length,
        buffer: bytes
      });
    }
  );

  it('routes a crafted array-index failure to the error handler', async () => {
    await expect(
      parse('pfp', [
        part('a[4294967294]', Buffer.from('x')),
        part('a[]', Buffer.from('y'))
      ])
    ).rejects.toMatchObject({ code: 'INVALID_FIELD_NAME' });
  });

  it('rejects unexpected or duplicate files', async () => {
    const file = part('pfp', Buffer.from('image'), 'fixture.png');
    await expect(parse('allowlist', [file])).rejects.toMatchObject({
      code: 'LIMIT_UNEXPECTED_FILE'
    });
    await expect(parse('pfp', [file, file])).rejects.toMatchObject({
      code: 'LIMIT_UNEXPECTED_FILE'
    });
  });

  it('rejects a truncated multipart stream and still accepts the next upload', async () => {
    const file = part('pfp', Buffer.from('image'), 'fixture.png');
    await expect(parse('pfp', [file], false)).rejects.toThrow(
      'Unexpected end of form'
    );
    expect((await parse('pfp', [file])).file?.buffer).toEqual(
      Buffer.from('image')
    );
  });
});
