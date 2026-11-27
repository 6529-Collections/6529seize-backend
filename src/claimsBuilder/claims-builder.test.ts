import type { Context, SQSEvent } from 'aws-lambda';
import type {
  ChainObject,
  WavesChainApi,
  WavesChainHead
} from '@/waves-chain-index/waves-chain-index.api';

/**
 * The claims builder lambda, from its SQS message to the minting claims
 * service. Each test is a cold start: the module loads afresh with nothing
 * in the environment, and the lambdas secret (doInDbContext) brings the
 * settings only when the handler runs, as in the deployed lambda. The mint
 * log's flags are off, so its recorder only runs the build.
 */

const hex = (pair: string) => `0x${pair.repeat(32)}`;
const DECISION = hex('d4');
const UNLISTED_DECISION = hex('d5');
const ENTRY = hex('e7');
const OTHER_ENTRY = hex('e8');
const MANIFEST = hex('f3');
const OTHER_MANIFEST = hex('f4');
const GATEWAY_URL = 'http://192.0.2.1:8080';
const DECISION_RESULTS =
  '@/waves-chain-index/waves-chain-index.decision-results';
const NOT_CONFIGURED = '[CHAIN GATEWAY NOT CONFIGURED]';

const SETTINGS = [
  'CHAIN_GATEWAY_URL',
  'CHAIN_GATEWAY_SERVICE_KEY',
  'CHAIN_GATEWAY_RETRIES',
  'MAIN_STAGE_DECISION_IDS',
  'FEATURE_MINT_LOG_SHADOW',
  'FEATURE_MINT_LOG_PRIMARY'
];

/** The gateway's URL alone: no CHAIN_GATEWAY_SERVICE_KEY. */
const CONFIGURED = {
  CHAIN_GATEWAY_URL: GATEWAY_URL,
  CHAIN_GATEWAY_RETRIES: '0',
  MAIN_STAGE_DECISION_IDS: DECISION
};
const UNCONFIGURED = { MAIN_STAGE_DECISION_IDS: DECISION };

function chainMessage(change: Record<string, unknown> = {}) {
  return {
    drop_id: 'drop-7',
    chain: {
      decision_id: DECISION,
      occurrence: 2,
      entry_id: ENTRY,
      height: 4100,
      manifest_hash: MANIFEST,
      ...change
    }
  };
}

const nativeMessage = {
  drop_id: 'drop-8',
  competition: {
    competition_id: 'competition-1',
    competition_entry_id: 'competition-entry-1',
    decision_id: 'decision-1'
  }
};

/** One decision's results, answered as the gateway reads them. */
class FakeResultsChain implements Pick<
  WavesChainApi,
  'head' | 'decisionResults' | 'entry'
> {
  results: ChainObject[] = [];
  readonly reads: string[] = [];
  private readonly manifests = new Map([
    [ENTRY, MANIFEST],
    [OTHER_ENTRY, OTHER_MANIFEST]
  ]);

  async head(): Promise<WavesChainHead> {
    this.reads.push('head');
    return {
      finalizedHeight: 4200,
      finalizedTime: 1_764_547_200_000,
      network: 'net-test'
    };
  }

  async decisionResults(decisionId: string): Promise<ChainObject[] | null> {
    this.reads.push('decisionResults');
    return decisionId === DECISION ? this.results : null;
  }

  async entry(entryId: string): Promise<ChainObject | null> {
    this.reads.push('entry');
    const manifestHash = this.manifests.get(entryId);
    return manifestHash ? { entryId, manifestHash } : null;
  }

  /** Occurrence 2's result: its stage, and its entries by rank. */
  settle(stage: 'final' | 'scoring', ranked: string[]) {
    this.results = [
      {
        id: DECISION,
        occurrence: 2,
        stage,
        winners: ranked.map((entryId, i) => ({ entryId, rank: i + 1 }))
      }
    ];
  }
}

const NETWORK = hex('22');
const FINALIZED = 4200;

function readStamp(height: number, at: 'finalized' | 'head') {
  return {
    at,
    height,
    finalizedHeight: FINALIZED,
    headHeight: FINALIZED + 3,
    network: NETWORK,
    time: 1_764_547_200_000 + height
  };
}

/**
 * The gateway's HTTP answers to the reads a chain claim makes (the status,
 * the decision's results, the winner's entry), as fetch gives them.
 */
function gatewayAnswers(result: ChainObject) {
  const head = readStamp(FINALIZED + 3, 'head');
  const finalized = readStamp(FINALIZED, 'finalized');
  const answers: Record<string, unknown> = {
    '/v1/status': {
      read: head,
      data: {
        ready: true,
        head,
        finalized,
        pinnable: { from: FINALIZED - 63, to: FINALIZED }
      },
      next: null
    },
    [`/v1/decisions/${DECISION}/results`]: {
      read: finalized,
      data: [result],
      next: null
    },
    [`/v1/entries/${ENTRY}`]: {
      read: finalized,
      data: { entryId: ENTRY, manifestHash: MANIFEST },
      next: null
    }
  };
  return async (url: string) => {
    const json = answers[new URL(url).pathname];
    const bytes = Buffer.from(JSON.stringify(json ?? null));
    return {
      status: json === undefined ? 500 : 200,
      headers: { get: () => null },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
    };
  };
}

interface Lambda {
  run(message: object): Promise<void>;
  readonly claims: {
    readonly claimIdForDrop: jest.Mock;
    readonly createClaimForDropIfMissing: jest.Mock;
  };
  readonly alerts: jest.Mock;
  readonly errors: jest.SpyInstance;
  notConfiguredLogs(): string[];
}

/**
 * Loads the lambda afresh. With `chain`, the bound port is the real
 * ChainDecisionResults over that fake chain; without it, over the real
 * gateway client.
 */
function coldStart(
  secret: Record<string, string>,
  chain?: FakeResultsChain
): Lambda {
  jest.resetModules();
  const claims = {
    claimIdForDrop: jest.fn(),
    createClaimForDropIfMissing: jest.fn().mockResolvedValue(undefined)
  };
  const alerts = jest.fn().mockResolvedValue(undefined);
  jest.doMock('@/sentry.context', () => ({
    wrapLambdaHandler: (fn: unknown) => fn
  }));
  jest.doMock('@/secrets', () => ({
    doInDbContext: async (work: () => Promise<unknown>) => {
      Object.assign(process.env, secret);
      return work();
    }
  }));
  jest.doMock('@/priority-alerts.context', () => ({
    sendPriorityAlert: alerts,
    sendPriorityAlertIfConfigured: jest.fn()
  }));
  jest.doMock('@/minting-claims/minting-claims.service', () => ({
    mintingClaimsService: claims,
    MintingClaimsService: class {}
  }));
  if (chain) {
    jest.doMock(DECISION_RESULTS, () => {
      const actual = jest.requireActual(DECISION_RESULTS);
      return {
        ...actual,
        chainDecisionResults: new actual.ChainDecisionResults(chain)
      };
    });
  } else {
    jest.dontMock(DECISION_RESULTS);
  }
  // The lambda's logger is kept by name, so it is spied on before the
  // lambda loads and gets it.
  const { Logger } = require('@/logging') as typeof import('@/logging');
  const logger = Logger.get('CLAIMS_BUILDER');
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const errors = jest
    .spyOn(logger, 'error')
    .mockImplementation(() => undefined);
  const { handler } = require('./index') as typeof import('./index');
  // Loading logs nothing: the settings come with the secret, in the handler.
  expect([info, warn, errors].map((spy) => spy.mock.calls.length)).toEqual([
    0, 0, 0
  ]);
  return {
    claims,
    alerts,
    errors,
    run: async (message) => {
      await handler(
        { Records: [{ body: JSON.stringify(message) }] } as SQSEvent,
        {} as Context,
        () => undefined
      );
    },
    notConfiguredLogs: () =>
      errors.mock.calls
        .map(([text]) => String(text))
        .filter((text) => text.startsWith(NOT_CONFIGURED))
  };
}

describe('claims builder: chain claims for the Main Stage', () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    for (const key of SETTINGS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    fetchMock = jest.fn().mockRejectedValue(new Error('connection refused'));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    for (const key of SETTINGS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    (globalThis as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('builds the claim when the final result ranks the entry first with its manifest', async () => {
    const chain = new FakeResultsChain();
    chain.settle('final', [ENTRY, OTHER_ENTRY]);
    const lambda = coldStart(CONFIGURED, chain);

    await lambda.run(chainMessage());

    expect(lambda.claims.createClaimForDropIfMissing).toHaveBeenCalledWith(
      'drop-7',
      undefined
    );
    // With the mint log off, the recorder runs the build and nothing else.
    expect(lambda.claims.claimIdForDrop).not.toHaveBeenCalled();
    expect(chain.reads).toEqual(['head', 'decisionResults', 'entry', 'entry']);
    expect(lambda.errors).not.toHaveBeenCalled();
    expect(lambda.alerts).not.toHaveBeenCalled();
  });

  it.each([
    ['another entry ranked first', 'final', [OTHER_ENTRY, ENTRY], {}],
    ['another manifest', 'final', [ENTRY], { manifest_hash: OTHER_MANIFEST }],
    ['a result still counting', 'scoring', [ENTRY], {}],
    ['an occurrence with no result', 'final', [ENTRY], { occurrence: 3 }]
  ] as const)(
    'refuses %s: the message fails, for SQS to retry',
    async (_label, stage, ranked, change) => {
      const chain = new FakeResultsChain();
      chain.settle(stage, [...ranked]);
      const lambda = coldStart(CONFIGURED, chain);

      await expect(lambda.run(chainMessage(change))).rejects.toThrow(
        /did not pick entry/
      );

      expect(lambda.claims.createClaimForDropIfMissing).not.toHaveBeenCalled();
      expect(lambda.alerts).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses a decision not in MAIN_STAGE_DECISION_IDS without reading the chain', async () => {
    const chain = new FakeResultsChain();
    chain.settle('final', [ENTRY]);
    const lambda = coldStart(CONFIGURED, chain);

    await expect(
      lambda.run(chainMessage({ decision_id: UNLISTED_DECISION }))
    ).rejects.toThrow(
      `Decision ${UNLISTED_DECISION} is not in MAIN_STAGE_DECISION_IDS`
    );

    expect(chain.reads).toEqual([]);
    expect(lambda.claims.createClaimForDropIfMissing).not.toHaveBeenCalled();
  });

  it('builds through the real gateway client with CHAIN_GATEWAY_URL alone, the secret bringing it', async () => {
    fetchMock.mockImplementation(
      gatewayAnswers({
        id: DECISION,
        occurrence: 2,
        stage: 'final',
        winners: [{ entryId: ENTRY, rank: 1 }]
      })
    );
    const lambda = coldStart(CONFIGURED);

    await lambda.run(chainMessage());

    expect(lambda.claims.createClaimForDropIfMissing).toHaveBeenCalledWith(
      'drop-7',
      undefined
    );
    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: new URL(url),
      authorization: init.headers.authorization
    }));
    expect(requests.map(({ url }) => url.origin + url.pathname)).toEqual([
      `${GATEWAY_URL}/v1/status`,
      `${GATEWAY_URL}/v1/decisions/${DECISION}/results`,
      `${GATEWAY_URL}/v1/entries/${ENTRY}`
    ]);
    // The reads are pinned to the finalized height, and carry no key.
    for (const { url } of requests.slice(1)) {
      expect(url.searchParams.get('height')).toBe(String(FINALIZED));
      expect(url.searchParams.get('network')).toBe(NETWORK);
    }
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      undefined,
      undefined,
      undefined
    ]);
    expect(lambda.errors).not.toHaveBeenCalled();
    expect(lambda.alerts).not.toHaveBeenCalled();
  });

  it('refuses a chain claim when the gateway cannot be read', async () => {
    const lambda = coldStart(CONFIGURED);

    await expect(lambda.run(chainMessage())).rejects.toThrow(
      'GET /v1/status failed: connection refused'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY_URL}/v1/status`);
    expect(lambda.notConfiguredLogs()).toEqual([]);
    expect(lambda.claims.createClaimForDropIfMissing).not.toHaveBeenCalled();
    expect(lambda.alerts).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['CHAIN_GATEWAY_URL is not set', UNCONFIGURED],
    [
      'CHAIN_GATEWAY_URL is not an http(s) URL',
      { ...UNCONFIGURED, CHAIN_GATEWAY_URL: 'not-a-url' }
    ]
  ])('when %s', (reason, secret) => {
    const logged =
      `${NOT_CONFIGURED} ${reason}. Chain claims are refused; after 10 ` +
      'receives SQS moves each one to claims-builder-dlq. To fix: set ' +
      'CHAIN_GATEWAY_URL in the lambdas secret, update or redeploy ' +
      'claimsBuilder so it starts cold (it reads the secret once), then ' +
      'redrive claims-builder-dlq. Native claims are built as before.';

    it('logs one error a cold start and refuses every chain claim', async () => {
      const lambda = coldStart(secret);
      await expect(lambda.run(chainMessage())).rejects.toThrow(reason);
      await expect(lambda.run(chainMessage())).rejects.toThrow(reason);

      expect(lambda.notConfiguredLogs()).toEqual([logged]);
      expect(lambda.claims.createClaimForDropIfMissing).not.toHaveBeenCalled();
      expect(lambda.alerts).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();

      // The next cold start says it again, once.
      const next = coldStart(secret);
      await expect(next.run(chainMessage())).rejects.toThrow(reason);
      await expect(next.run(chainMessage())).rejects.toThrow(reason);
      expect(next.notConfiguredLogs()).toEqual([logged]);
    });

    it('builds a native claim as before', async () => {
      const lambda = coldStart(secret);

      await lambda.run(nativeMessage);
      await lambda.run(nativeMessage);

      expect(lambda.claims.createClaimForDropIfMissing).toHaveBeenCalledTimes(
        2
      );
      expect(lambda.claims.createClaimForDropIfMissing).toHaveBeenCalledWith(
        'drop-8',
        nativeMessage.competition
      );
      expect(lambda.notConfiguredLogs()).toEqual([logged]);
      expect(lambda.alerts).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('builds a native claim without reading the chain when the gateway is set', async () => {
    const chain = new FakeResultsChain();
    const lambda = coldStart(CONFIGURED, chain);

    await lambda.run(nativeMessage);

    expect(lambda.claims.createClaimForDropIfMissing).toHaveBeenCalledWith(
      'drop-8',
      nativeMessage.competition
    );
    expect(chain.reads).toEqual([]);
    expect(lambda.errors).not.toHaveBeenCalled();
  });
});
