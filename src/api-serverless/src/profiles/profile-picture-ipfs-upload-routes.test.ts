import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { ApiCompliantException, UnauthorisedException } from '@/exceptions';
import { ipfsFileUploader } from '@/attachments/ipfs-file-uploader';
import { PROFILE_PICTURE_MAX_BYTES } from './profile-picture-ipfs-upload';

jest.mock('@/api/auth/auth', () => ({
  ...jest.requireActual('@/api/auth/auth'),
  maybeAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  needsAuthenticatedUser:
    () => (req: Request, _res: Response, next: NextFunction) => {
      if (req.headers.authorization !== 'Bearer test-session') {
        next(new UnauthorisedException('Unauthorized'));
        return;
      }
      (req as any).user = {
        wallet: '0x1111111111111111111111111111111111111111'
      };
      next();
    }
}));
jest.mock('@/attachments/ipfs-file-uploader', () => ({
  ipfsFileUploader: { uploadFile: jest.fn() }
}));
jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import router from './profiles.routes';

const uploadFile = jest.mocked(ipfsFileUploader.uploadFile);
// A complete 1x1 RGBA PNG: profile pictures are parsed to strip metadata.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000970485973000003e8000003e801b57b526b0000000d4944415408996330' +
    '4e9bd9000003b501b388f521dd0000000049454e44ae426082',
  'hex'
);

async function upload({
  bytes,
  fileName = 'avatar.png',
  type = 'image/png',
  field = 'pfp',
  authenticated = true
}: {
  bytes?: Buffer;
  fileName?: string;
  type?: string;
  field?: string;
  authenticated?: boolean;
}): Promise<{ status: number; body: any }> {
  const app = express();
  app.use('/profiles', router);
  app.use(
    (
      error: ApiCompliantException,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res.status(error.getStatusCode?.() ?? 500).send({ error: error.message });
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing test address');
    }
    const form = new FormData();
    if (bytes) {
      form.append(field, new Blob([bytes], { type }), fileName);
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/profiles/pfp/ipfs`,
      {
        method: 'POST',
        headers: authenticated ? { authorization: 'Bearer test-session' } : {},
        body: form
      }
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('POST /profiles/pfp/ipfs', () => {
  beforeEach(() => {
    uploadFile.mockReset();
    uploadFile.mockResolvedValue({
      cid: 'QmUploadedPicture',
      url: 'ipfs://QmUploadedPicture'
    });
  });

  it('requires an authenticated user', async () => {
    const response = await upload({ bytes: PNG, authenticated: false });

    expect(response.status).toBe(401);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('pins a recognised image whatever its name and declared type', async () => {
    const response = await upload({
      bytes: PNG,
      fileName: 'avatar.gif',
      type: 'text/plain'
    });

    expect(response).toEqual({
      status: 201,
      body: { pfp_url: 'ipfs://QmUploadedPicture' }
    });
    expect(uploadFile).toHaveBeenCalledWith({
      fileName: 'pfp.png',
      fileBuffer: PNG,
      contentType: 'image/png'
    });
  });

  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['html', '<!doctype html><title>x</title>']
  ])(
    'rejects %s content sent as avatar.png with an image/png type',
    async (_, text) => {
      const response = await upload({ bytes: Buffer.from(text) });

      expect(response.status).toBe(400);
      expect(uploadFile).not.toHaveBeenCalled();
    }
  );

  it('rejects an empty file and a missing file', async () => {
    expect((await upload({ bytes: Buffer.alloc(0) })).status).toBe(400);
    expect((await upload({})).status).toBe(400);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a file over 2 MiB with 413 before it is inspected', async () => {
    const response = await upload({
      bytes: Buffer.concat([PNG, Buffer.alloc(PROFILE_PICTURE_MAX_BYTES)])
    });

    expect(response.status).toBe(413);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 2 MiB', async () => {
    const bytes = Buffer.concat([
      PNG,
      Buffer.alloc(PROFILE_PICTURE_MAX_BYTES - PNG.length)
    ]);

    expect((await upload({ bytes })).status).toBe(201);
  });
});
