import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CustomApiCompliantException } from '@/exceptions';

// This must be require and not import because of how multer works
const multerMiddleware = require('multer');

export interface MulterSingleMiddlewareOptions {
  /** Largest accepted file. Larger uploads are rejected with HTTP 413. */
  readonly maxFileSizeBytes?: number;
}

export function initMulterSingleMiddleware(
  v: string,
  { maxFileSizeBytes }: MulterSingleMiddlewareOptions = {}
): RequestHandler {
  const storage = multerMiddleware.memoryStorage();
  const m = multerMiddleware({
    storage: storage,
    ...(maxFileSizeBytes === undefined
      ? {}
      : { limits: { fileSize: maxFileSizeBytes, files: 1 } })
  });
  const handler: RequestHandler = m.single(v);
  if (maxFileSizeBytes === undefined) {
    return handler;
  }
  return (req: Request, res: Response, next: NextFunction) =>
    handler(req, res, (error?: unknown) => {
      if (
        (error as { code?: unknown } | undefined)?.code === 'LIMIT_FILE_SIZE'
      ) {
        next(new CustomApiCompliantException(413, 'File is too large'));
        return;
      }
      next(error);
    });
}
