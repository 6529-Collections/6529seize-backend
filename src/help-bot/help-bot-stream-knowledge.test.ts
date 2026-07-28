import { createHash } from 'node:crypto';
import {
  FrontendStreamKnowledgeSource,
  StreamKnowledgeFetcher,
  STREAM_KNOWLEDGE_TESTING
} from './help-bot-stream-knowledge';

const BASE_URL = 'https://frontend.example';
const REVIEW_ID = '6529-stream';
const VERSION = '2026-07-27.1';
const COMMIT = '513bd7e079eafe109df6ae1ae21bfbca6fec6786';
const TREE = 'b50ec53109f5f8d6b4f4b07f4cb6fd3c1d0e3100';
const REFERENCE_SHA =
  'sha256:11daa4d88d196d03fd8181b6e42409a856b0280c57dc7b5f276e9daa0e9a0dff';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key])
        ])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

interface Fixture {
  readonly files: Map<string, string>;
  readonly fetcher: jest.MockedFunction<StreamKnowledgeFetcher>;
}

function technicalRecord({
  id,
  kind,
  title,
  name,
  signature,
  selector,
  topic0,
  definitionName,
  scope = 'protocol',
  classification = 'production_release_contract',
  sourcePath = 'smart-contracts/AuctionContract.sol',
  inputs = [],
  outputs = []
}: {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly name: string;
  readonly signature: string;
  readonly selector?: string;
  readonly topic0?: string;
  readonly definitionName: string;
  readonly scope?: 'protocol' | 'script' | 'test';
  readonly classification?: string;
  readonly sourcePath?: string;
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly unknown[];
}) {
  const canonicalPath = `/reviews/${REVIEW_ID}/versions/${VERSION}/reference/definitions/${definitionName}/${kind}s/${name}`;
  return {
    catalog: {
      id,
      category: 'technical',
      kind,
      title,
      name,
      signature,
      ...(selector ? { selector } : {}),
      ...(topic0 ? { topic0 } : {}),
      definitionName,
      scope,
      classification,
      sourcePath,
      searchText: `${title} ${scope} ${classification}`,
      recordShard: 0
    },
    evidence: {
      id,
      category: 'technical',
      kind,
      title,
      name,
      signature,
      ...(selector ? { selector } : {}),
      ...(topic0 ? { topic0 } : {}),
      canonicalPath,
      sourcePath,
      sourceLink: `${canonicalPath}#source`,
      scope,
      classification,
      summary: `${signature} is declared by ${definitionName}.`,
      provenance: {
        reviewVersion: VERSION,
        sourceCommit: COMMIT,
        sourcePath,
        range: { lineStart: 1, lineEnd: 4 }
      },
      technical: {
        definitionId: `${sourcePath}:${definitionName}`,
        definitionName,
        definitionKind: 'contract',
        declaration: {
          name,
          canonicalSignature: signature,
          displaySignature: signature,
          ...(selector ? { selector } : {}),
          ...(topic0 ? { topic0 } : {}),
          inputs,
          outputs,
          visibility: 'external',
          stateMutability: 'nonpayable',
          modifiers: []
        }
      },
      relationships: {
        relatedDefinitionId: `definition:${sourcePath}:${definitionName}`,
        relatedEditorialIds: [
          'editorial:fixed-price-sales-and-auctions:sale-modes'
        ]
      }
    }
  };
}

function buildFixture(version = VERSION): Fixture {
  const editorial = [
    {
      id: 'editorial:overview:intro',
      category: 'editorial',
      kind: 'editorial_section',
      title: '6529 Stream Overview',
      name: 'Overview',
      aliases: ['stream', '6529 stream', 'stream overview'],
      searchText:
        'Stream is a candidate protocol for artist-led drops, curation, fixed-price sales, and auctions.',
      recordShard: 0,
      canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}`,
      text: 'Stream is a candidate protocol for artist-led drops, curation, fixed-price sales, and auctions.'
    },
    {
      id: 'editorial:fixed-price-sales-and-auctions:sale-modes',
      category: 'editorial',
      kind: 'editorial_section',
      title: 'Fixed-Price Sales and Auctions: Sale modes',
      name: 'Sale modes',
      aliases: ['sale modes', 'fixed price', 'auctions'],
      searchText:
        'sale modes fixed price auction free or paid mint native ETH auction reserve bidding',
      recordShard: 0,
      canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}/fixed-price-sales-and-auctions#sale-modes`,
      text: 'The pinned implementation has fixed-price authorization paths for free or paid mints and a separate auction path.'
    },
    {
      id: 'editorial:curation-and-tdh-authorization:intro',
      category: 'editorial',
      kind: 'editorial_section',
      title: 'Curation and TDH Authorization',
      name: 'Curation and TDH Authorization',
      aliases: ['tdh curation', 'artist authorization'],
      searchText:
        'tdh curation artist authorization signed eip 712 offchain decision exact payload',
      recordShard: 0,
      canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}/curation-and-tdh-authorization`,
      text: 'An offchain curation or TDH decision is bound into an exact EIP-712 authorization before a contract call.'
    }
  ];
  const withdraw = technicalRecord({
    id: 'declaration:smart-contracts/AuctionContract.sol:StreamAuctions#function:0x7649eec6',
    kind: 'function',
    title: 'StreamAuctions.withdrawBidderCredit()',
    name: 'withdrawBidderCredit',
    signature: 'withdrawBidderCredit()',
    selector: '0x7649eec6',
    definitionName: 'StreamAuctions'
  });
  const event = technicalRecord({
    id: 'declaration:smart-contracts/AuctionContract.sol:StreamAuctions#event:BidderCreditWithdrawn',
    kind: 'event',
    title: 'StreamAuctions.BidderCreditWithdrawn(address,address,uint256)',
    name: 'BidderCreditWithdrawn',
    signature: 'BidderCreditWithdrawn(address,address,uint256)',
    topic0:
      '0x3f8729566a11fa4d9d7a96b1c030f775c0f1b9156d228a35ba90583747e7b8af',
    definitionName: 'StreamAuctions'
  });
  const error = technicalRecord({
    id: 'declaration:smart-contracts/IStreamArtworkFinalityRegistry.sol:IStreamArtworkFinalityRegistry#error:0x1308739d',
    kind: 'error',
    title:
      'IStreamArtworkFinalityRegistry.FinalityCallerNotFinalityAdmin(address)',
    name: 'FinalityCallerNotFinalityAdmin',
    signature: 'FinalityCallerNotFinalityAdmin(address)',
    selector: '0x1308739d',
    definitionName: 'IStreamArtworkFinalityRegistry',
    sourcePath: 'smart-contracts/IStreamArtworkFinalityRegistry.sol'
  });
  const script = technicalRecord({
    id: 'declaration:script/RehearseDeployment.s.sol:RehearseDeployment#function:0x3f936c39',
    kind: 'function',
    title: 'RehearseDeployment.runSepolia()',
    name: 'runSepolia',
    signature: 'runSepolia()',
    selector: '0x3f936c39',
    definitionName: 'RehearseDeployment',
    scope: 'script',
    classification: 'deployment_or_operational_source',
    sourcePath: 'script/RehearseDeployment.s.sol'
  });
  const testHandler = technicalRecord({
    id: 'declaration:test/StreamAuctionInvariant.t.sol:AuctionConsistencyInvariantHandler#function:0x53e3637f',
    kind: 'function',
    title: 'AuctionConsistencyInvariantHandler.withdrawBidderCredit(uint256)',
    name: 'withdrawBidderCredit',
    signature: 'withdrawBidderCredit(uint256)',
    selector: '0x53e3637f',
    definitionName: 'AuctionConsistencyInvariantHandler',
    scope: 'test',
    classification: 'test_or_harness_source',
    sourcePath: 'test/StreamAuctionInvariant.t.sol',
    inputs: [{ index: 0, name: 'seed', type: 'uint256' }]
  });
  const definitions = [
    {
      id: 'definition:smart-contracts/AuctionContract.sol:StreamAuctions',
      category: 'technical',
      kind: 'contract',
      title: 'StreamAuctions contract',
      name: 'StreamAuctions',
      sourcePath: 'smart-contracts/AuctionContract.sol',
      scope: 'protocol',
      classification: 'production_release_contract',
      searchText: 'Stream auction protocol sale bid credit withdrawal',
      recordShard: 0,
      canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}/reference/definitions/StreamAuctions`,
      summary:
        'StreamAuctions is classified as a production release protocol contract.'
    },
    {
      id: 'definition:script/RehearseDeployment.s.sol:RehearseDeployment',
      category: 'technical',
      kind: 'contract',
      title: 'RehearseDeployment contract',
      name: 'RehearseDeployment',
      sourcePath: 'script/RehearseDeployment.s.sol',
      scope: 'script',
      classification: 'deployment_or_operational_source',
      searchText: 'Sepolia deployment rehearsal script not protocol',
      recordShard: 0,
      canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}/reference/definitions/RehearseDeployment`,
      summary:
        'RehearseDeployment is deployment or operational script source, not protocol code.'
    }
  ];
  const status = {
    id: `status:${version}:review-state`,
    category: 'status',
    kind: 'review_status',
    title: 'Stream implementation and readiness',
    name: 'review state',
    aliases: ['audit status', 'deployment status', 'readiness'],
    searchText:
      'pre audit not deployed candidate implementation readiness blockers',
    recordShard: 0,
    canonicalPath: `/reviews/${REVIEW_ID}/versions/${version}/current-implementation-and-readiness`,
    summary:
      'The reviewed candidate is PRE_AUDIT and NOT_DEPLOYED; implemented code is not deployment evidence.',
    structured: {
      auditStatus: 'PRE_AUDIT',
      deploymentStatus: 'NOT_DEPLOYED'
    }
  };
  const pairs = [withdraw, event, error, script, testHandler];
  const catalog = [
    ...editorial.map(
      ({ canonicalPath: _canonicalPath, text: _text, ...record }) => record
    ),
    ...pairs.map((pair) => pair.catalog),
    ...definitions.map(
      ({ canonicalPath: _canonicalPath, summary: _summary, ...record }) =>
        record
    ),
    (({
      canonicalPath: _canonicalPath,
      summary: _summary,
      structured: _structured,
      ...record
    }) => record)(status)
  ];
  const evidence = [
    ...editorial.map(
      ({ searchText: _searchText, recordShard: _recordShard, ...record }) => ({
        ...record,
        provenance: { reviewVersion: version, sourceCommit: COMMIT },
        relationships: { relatedEditorialIds: [] }
      })
    ),
    ...pairs.map((pair) => pair.evidence),
    ...definitions.map(
      ({ searchText: _searchText, recordShard: _recordShard, ...record }) => ({
        ...record,
        provenance: {
          reviewVersion: version,
          sourceCommit: COMMIT,
          sourcePath: record.sourcePath
        },
        relationships: { relatedEditorialIds: [] }
      })
    ),
    (({ searchText: _searchText, recordShard: _recordShard, ...record }) => ({
      ...record,
      provenance: { reviewVersion: version, sourceCommit: COMMIT },
      relationships: {
        relatedEditorialIds: ['editorial:overview:intro']
      }
    }))(status)
  ];
  const prefix = `/review-data/${REVIEW_ID}/versions/${version}/knowledge`;
  const shard = {
    schemaVersion: 'public-review.knowledge-shard.v1',
    reviewId: REVIEW_ID,
    reviewVersion: version,
    shard: 0,
    records: evidence
  };
  const shardText = JSON.stringify(shard);
  const searchIndex = {
    schemaVersion: 'public-review.knowledge-index.v1',
    reviewId: REVIEW_ID,
    reviewVersion: version,
    source: {
      repository: '6529-Collections/6529Stream',
      commit: COMMIT,
      tree: TREE
    },
    referenceBundleSha256: REFERENCE_SHA,
    records: catalog
  };
  const searchText = JSON.stringify(searchIndex);
  const manifest: Record<string, unknown> = {
    schemaVersion: 'public-review.knowledge-manifest.v1',
    reviewId: REVIEW_ID,
    reviewVersion: version,
    source: {
      repository: '6529-Collections/6529Stream',
      commit: COMMIT,
      tree: TREE
    },
    publication: {
      lifecycleState: 'PUBLIC_REVIEW',
      deploymentStatus: 'NOT_DEPLOYED',
      auditStatus: 'PRE_AUDIT'
    },
    reference: {
      manifestPath: `/review-data/${REVIEW_ID}/versions/${version}/reference-manifest.json`,
      manifestSha256:
        'sha256:2b3f591ae0195b236534455f5723b4f7aef53a0574255bff921b866f5ebfa351',
      bundleSha256: REFERENCE_SHA
    },
    generator: {
      name: '6529-public-review-stream-knowledge',
      version: '1',
      sourceSha256:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    searchIndex: {
      path: `${prefix}/search-index.json`,
      sha256: sha256(searchText),
      recordCount: catalog.length
    },
    recordShards: [
      {
        path: `${prefix}/records/000.json`,
        sha256: sha256(shardText),
        recordCount: evidence.length
      }
    ],
    counts: { total: catalog.length },
    knowledgeSha256: null
  };
  const identityManifest = { ...manifest };
  delete identityManifest.knowledgeSha256;
  manifest.knowledgeSha256 = sha256(stableJson(identityManifest));
  const reviewIndex = {
    schemaVersion: 'public-review.solidity-reference-index.v1',
    reviewId: REVIEW_ID,
    activeVersion: version,
    versions: [
      {
        version,
        commit: COMMIT,
        tree: TREE,
        bundlePath: `/review-data/${REVIEW_ID}/versions/${version}/reference-manifest.json`,
        bundleSha256: REFERENCE_SHA
      }
    ]
  };
  const files = new Map<string, string>([
    [`/review-data/${REVIEW_ID}/index.json`, JSON.stringify(reviewIndex)],
    [`${prefix}/manifest.json`, JSON.stringify(manifest)],
    [`${prefix}/search-index.json`, searchText],
    [`${prefix}/records/000.json`, shardText]
  ]);
  const fetcher = jest.fn<
    ReturnType<StreamKnowledgeFetcher>,
    Parameters<StreamKnowledgeFetcher>
  >(async (url) => {
    const pathname = new URL(url).pathname;
    const text = files.get(pathname);
    return text === undefined
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => text };
  });
  return { files, fetcher };
}

describe('FrontendStreamKnowledgeSource', () => {
  it.each([
    ['what is stream?', 'editorial:overview:intro'],
    [
      'what sale modes does stream support?',
      'editorial:fixed-price-sales-and-auctions:sale-modes'
    ],
    [
      'how does TDH affect Stream curation and artist authorization?',
      'editorial:curation-and-tdh-authorization:intro'
    ]
  ])('retrieves conceptual Stream evidence for %s', async (question, id) => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const match = await source.findMatch(question);
    const firstEvidence = JSON.parse(
      match?.record.facts.find((fact) => fact.startsWith('{')) ?? '{}'
    ) as { readonly id?: string };

    expect(match?.record.kind).toBe('public_review_knowledge');
    expect(match?.record.facts.join('\n')).toContain(id);
    expect(firstEvidence.id).toBe(id);
    expect(match?.record.facts.join('\n')).toContain(VERSION);
    expect(match?.record.facts.join('\n')).toContain(COMMIT);
  });

  it.each([
    ['withdrawBidderCredit', 'withdrawBidderCredit()', '0x7649eec6'],
    ['withdrawBidderCredit()', 'withdrawBidderCredit()', '0x7649eec6'],
    ['0x7649eec6', 'withdrawBidderCredit()', '0x7649eec6'],
    [
      '0x3f8729566a11fa4d9d7a96b1c030f775c0f1b9156d228a35ba90583747e7b8af',
      'BidderCreditWithdrawn(address,address,uint256)',
      'event'
    ],
    ['0x1308739d', 'FinalityCallerNotFinalityAdmin(address)', 'error']
  ])(
    'gives exact declarations precedence for %s',
    async (question, signature, discriminator) => {
      const fixture = buildFixture();
      const source = new FrontendStreamKnowledgeSource(
        fixture.fetcher,
        BASE_URL
      );

      const match = await source.findMatch(question);
      const evidence = match?.record.facts.join('\n') ?? '';

      expect(evidence).toContain(signature);
      expect(evidence).toContain(discriminator);
      expect(evidence.indexOf(signature)).toBeLessThan(
        evidence.indexOf('sale-modes')
      );
    }
  );

  it('preserves Solidity inputs, outputs, visibility, mutability, and source classification', async () => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const protocol = await source.findMatch(
      'what inputs does withdrawBidderCredit take?'
    );
    const script = await source.findMatch(
      'is runSepolia protocol code or a Sepolia script?'
    );

    expect(protocol?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"inputs":[]')
    );
    expect(protocol?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"outputs":[]')
    );
    expect(protocol?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"visibility":"external"')
    );
    expect(protocol?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"stateMutability":"nonpayable"')
    );
    expect(protocol?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"scope":"protocol"')
    );
    expect(script?.record.facts.join('\n')).toEqual(
      expect.stringContaining('"scope":"script"')
    );
    expect(script?.record.facts.join('\n')).toEqual(
      expect.stringContaining(
        '"classification":"deployment_or_operational_source"'
      )
    );
  });

  it('prefers an exact protocol callable over a same-name test harness helper', async () => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const match = await source.findMatch('withdrawBidderCredit');
    const evidence = match?.record.facts.join('\n') ?? '';

    expect(evidence).not.toContain('AMBIGUITY:');
    expect(
      evidence.indexOf('StreamAuctions.withdrawBidderCredit()')
    ).toBeLessThan(
      evidence.indexOf(
        'AuctionConsistencyInvariantHandler.withdrawBidderCredit(uint256)'
      )
    );
  });

  it('builds a deduplicated bounded packet with four to ten evidence records', async () => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const match = await source.findMatch(
      'explain Stream sale modes, auctions, TDH curation, audit and deployment status'
    );
    const evidence = (match?.record.facts ?? []).filter((fact) =>
      fact.startsWith('{')
    );

    expect(evidence.length).toBeGreaterThanOrEqual(
      STREAM_KNOWLEDGE_TESTING.MIN_EVIDENCE_RECORDS
    );
    expect(evidence.length).toBeLessThanOrEqual(
      STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_RECORDS
    );
    expect(new Set(evidence).size).toBe(evidence.length);
    expect((match?.record.facts ?? []).join('').length).toBeLessThanOrEqual(
      STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_PACKET_CHARACTERS
    );
  });

  it('keeps a contextual follow-up scoped to the exact prior Stream symbol', async () => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const match = await source.findMatch(
      'who can call this function?',
      `The 6529 Stream review says StreamAuctions.withdrawBidderCredit() lets a bidder withdraw credit: ${BASE_URL}/reviews/6529-stream.`
    );
    const firstEvidence = JSON.parse(
      match?.record.facts.find((fact) => fact.startsWith('{')) ?? '{}'
    ) as { readonly id?: string };

    expect(match?.record.kind).toBe('public_review_knowledge');
    expect(firstEvidence.id).toBe(
      'declaration:smart-contracts/AuctionContract.sol:StreamAuctions#function:0x7649eec6'
    );
  });

  it('switches active versions and does not reuse the old catalog', async () => {
    const first = buildFixture();
    const second = buildFixture('2026-07-28.1');
    const source = new FrontendStreamKnowledgeSource(
      first.fetcher,
      BASE_URL,
      1
    );
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    expect((await source.findMatch('what is stream?'))?.record.id).toContain(
      VERSION
    );
    for (const [path, value] of Array.from(second.files.entries())) {
      first.files.set(path, value);
    }
    first.files.set(
      `/review-data/${REVIEW_ID}/index.json`,
      second.files.get(`/review-data/${REVIEW_ID}/index.json`)!
    );
    now.mockReturnValue(1_002);

    expect((await source.findMatch('what is stream?'))?.record.id).toContain(
      '2026-07-28.1'
    );
    now.mockRestore();
  });

  it('rejects identity and checksum drift', async () => {
    const fixture = buildFixture();
    const manifestPath = `/review-data/${REVIEW_ID}/versions/${VERSION}/knowledge/manifest.json`;
    const manifest = JSON.parse(fixture.files.get(manifestPath)!) as Record<
      string,
      unknown
    >;
    (manifest.source as Record<string, unknown>).commit =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    fixture.files.set(manifestPath, JSON.stringify(manifest));
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    await expect(source.findMatch('what is stream?')).resolves.toBeNull();

    const checksumFixture = buildFixture();
    const searchPath = `/review-data/${REVIEW_ID}/versions/${VERSION}/knowledge/search-index.json`;
    checksumFixture.files.set(
      searchPath,
      `${checksumFixture.files.get(searchPath)} `
    );
    await expect(
      new FrontendStreamKnowledgeSource(
        checksumFixture.fetcher,
        BASE_URL
      ).findMatch('what is stream?')
    ).resolves.toBeNull();
  });

  it('fails closed after a published corpus is withdrawn instead of serving stale evidence', async () => {
    const fixture = buildFixture();
    const source = new FrontendStreamKnowledgeSource(
      fixture.fetcher,
      BASE_URL,
      1
    );
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000);

    await expect(source.findMatch('what is stream?')).resolves.not.toBeNull();
    fixture.files.delete(`/review-data/${REVIEW_ID}/index.json`);
    now.mockReturnValue(2_002);

    await expect(source.findMatch('what is stream?')).resolves.toBeNull();
    now.mockRestore();
  });

  it('treats a missing public review index as an unavailable optional corpus', async () => {
    const fixture = buildFixture();
    fixture.files.clear();

    await expect(
      new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL).findMatch(
        'what is stream?'
      )
    ).resolves.toBeNull();
  });
});
