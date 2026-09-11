import { ErrorRequestHandler, RequestHandler } from 'express';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import { CMS_AGENT_MAX_BYTES } from '@/profile-cms/profile-cms-agent-candidate';

export function isCmsAgentRequest(path: string): boolean {
  return /^\/api\/profile-cms\/(?:agent-session(?:\/|$)|agent-(?:grants|proposals)(?:\/|$)|packages\/[^/]+\/agent-(?:grants|proposals)(?:\/|$))/i.test(
    path.split('?')[0]
  );
}

export function validateCmsAgentRawBody(path: string, bytes: number): void {
  if (isCmsAgentRequest(path) && bytes > CMS_AGENT_MAX_BYTES) {
    throw new CustomApiCompliantException(
      413,
      'CMS agent request is too large',
      'cms_agent_request_too_large'
    );
  }
}

export const cmsAgentPrivateHeadersMiddleware: RequestHandler = (
  req,
  res,
  next
) => {
  if (isCmsAgentRequest(req.path)) {
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff'
    });
  }
  next();
};

export function sanitizeCmsAgentError(error: unknown): ApiCompliantException {
  if (error instanceof ApiCompliantException) {
    return new CustomApiCompliantException(
      error.getStatusCode(),
      error.code?.startsWith('cms_agent_')
        ? error.message
        : 'Invalid CMS agent request',
      error.code
    );
  }
  const parser = error as { type?: unknown; status?: unknown } | null;
  if (parser?.type === 'entity.parse.failed' && parser.status === 400) {
    return new CustomApiCompliantException(
      400,
      'Invalid CMS agent JSON',
      'cms_agent_invalid_json'
    );
  }
  if (parser?.type === 'entity.too.large' && parser.status === 413) {
    return new CustomApiCompliantException(
      413,
      'CMS agent request is too large',
      'cms_agent_request_too_large'
    );
  }
  return new CustomApiCompliantException(
    500,
    'CMS agent operation failed',
    'cms_agent_operation_failed'
  );
}

export const cmsAgentErrorMiddleware: ErrorRequestHandler = (
  error: unknown,
  req,
  _res,
  next
) => {
  if (!isCmsAgentRequest(req.path)) return next(error);
  req.body = undefined;
  req.query = {};
  req.originalUrl = req.path;
  delete req.headers.authorization;
  delete req.headers.cookie;
  // Parser and database errors can carry request bytes. Recreate before error reporting.
  return next(sanitizeCmsAgentError(error));
};
