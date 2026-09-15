import express, { NextFunction, Request, Response } from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import { Timer } from '@/time';
import { CMS_AGENT_MAX_BYTES } from '@/profile-cms/profile-cms-agent-candidate';
import {
  GetProfileCmsAgentDraftRequest,
  CreateProfileCmsAgentGrantRequest
} from '@/api/generated/routes/operations';

const mockService = { readDraft: jest.fn(), issue: jest.fn() };
jest.mock('@/api/profile-cms/profile-cms-agent.api.service', () => ({
  profileCmsAgentApiService: mockService
}));
import {
  handleGetProfileCmsAgentDraft,
  handleCreateProfileCmsAgentGrant
} from './profile-cms-agent.handlers';
import {
  validateCmsAgentRawBody,
  isCmsAgentRequest,
  cmsAgentErrorMiddleware,
  sanitizeCmsAgentError
} from './profile-cms-agent.http';

const token = `cms_agent_00000000-0000-4000-8000-000000000000.${'a'.repeat(64)}`;
function request() {
  return {
    params: {},
    query: {},
    body: undefined as unknown,
    headers: { authorization: `Bearer ${token}`, cookie: 'private-cookie' },
    timer: new Timer('agent-handler-test'),
    res: { set: jest.fn() }
  };
}

describe('CMS agent HTTP boundaries', () => {
  beforeEach(() => jest.resetAllMocks());

  it.each(['Bearer ordinary.website.jwt', '', 'Basic secret'])(
    'does not pass %s to the capability service',
    async (header) => {
      const req = request();
      req.headers.authorization = header;
      await expect(
        handleGetProfileCmsAgentDraft(
          req as unknown as GetProfileCmsAgentDraftRequest
        )
      ).rejects.toMatchObject({ code: 'cms_agent_invalid_grant' });
      expect(mockService.readDraft).not.toHaveBeenCalled();
      expect(req.headers).not.toHaveProperty('authorization');
      expect(req.headers).not.toHaveProperty('cookie');
    }
  );

  it('does not accept a credential in a query or leak it into errors', async () => {
    const req = { ...request(), query: { token } };
    await expect(
      handleGetProfileCmsAgentDraft(
        req as unknown as GetProfileCmsAgentDraftRequest
      )
    ).rejects.toThrow();
    expect(mockService.readDraft).not.toHaveBeenCalled();
  });

  it('suppresses internal database details and private request content in errors', async () => {
    const req = request();
    req.body = { secret: 'private draft text' };
    mockService.readDraft.mockRejectedValue(
      new Error('database SQL contains private draft text')
    );
    await expect(
      handleGetProfileCmsAgentDraft(
        req as unknown as GetProfileCmsAgentDraftRequest
      )
    ).rejects.toMatchObject({
      code: 'cms_agent_operation_failed',
      message: 'CMS agent operation failed'
    });
    expect(req.body).toBeUndefined();
    expect(req.res.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Cache-Control': 'private, no-store' })
    );
  });

  it.each([0, 59, 86401, -1])(
    'rejects an invalid %s-second expiration before issuance',
    async (seconds) => {
      const req = {
        ...request(),
        params: { id: 'draft' },
        user: { wallet: `0x${'1'.repeat(40)}` },
        body: {
          label: 'Agent',
          expected_package_hash: `sha256:${'a'.repeat(64)}`,
          expires_in_seconds: seconds
        }
      };
      await expect(
        handleCreateProfileCmsAgentGrant(
          req as unknown as CreateProfileCmsAgentGrantRequest
        )
      ).rejects.toThrow();
      expect(mockService.issue).not.toHaveBeenCalled();
    }
  );

  it('classifies all private owner and agent routes without changing regular CMS routes', () => {
    [
      '/api/profile-cms/agent-session/draft',
      '/api/profile-cms/agent-grants/id',
      '/api/profile-cms/agent-proposals/id',
      '/api/profile-cms/packages/id/agent-grants',
      '/api/profile-cms/packages/id/agent-proposals',
      '/API/PROFILE-CMS/PACKAGES/id/AGENT-GRANTS?ignored=value'
    ].forEach((path) => expect(isCmsAgentRequest(path)).toBe(true));
    expect(isCmsAgentRequest('/api/profile-cms/packages/id/publish')).toBe(
      false
    );
  });

  it('removes raw parser bodies and internal error detail before reporting', () => {
    const error = Object.assign(new Error('private JSON content'), {
      type: 'entity.parse.failed',
      status: 400,
      body: 'private JSON content'
    });
    const safe = sanitizeCmsAgentError(error);
    expect(safe.getStatusCode()).toBe(400);
    expect(safe.message).toBe('Invalid CMS agent JSON');
    expect(safe).not.toHaveProperty('body');
    expect(
      sanitizeCmsAgentError(new Error('SQL private content')).message
    ).toBe('CMS agent operation failed');
  });

  it('rejects oversized raw JSON before parsing with the documented status', async () => {
    const app = express();
    app.use(
      express.json({
        limit: '5mb',
        verify: (req, _res, buffer) =>
          validateCmsAgentRawBody(req.url ?? '', buffer.length)
      })
    );
    app.post('/api/profile-cms/agent-session/proposals', (_req, res) => {
      res.sendStatus(200);
    });
    app.use(cmsAgentErrorMiddleware);
    app.use(
      (
        error: ApiCompliantException,
        _req: Request,
        res: Response,
        _next: NextFunction
      ) => {
        res.status(error.getStatusCode()).send({ code: error.code });
      }
    );
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/profile-cms/agent-session/proposals`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'x'.repeat(CMS_AGENT_MAX_BYTES) })
        }
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        code: 'cms_agent_request_too_large'
      });
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve()))
        );
    }
  });
});
