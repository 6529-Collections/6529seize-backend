import { createHash } from 'node:crypto';
import fc from 'fast-check';
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

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compareCodeUnits)
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
      ? { ok: false, status: 404, text: '' }
      : { ok: true, status: 200, text };
  });
  return { files, fetcher };
}

function addDevelopmentStatusFixture(fixture: Fixture): Fixture {
  const prefix = `/review-data/${REVIEW_ID}/versions/${VERSION}/knowledge`;
  const searchPath = `${prefix}/search-index.json`;
  const shardPath = `${prefix}/records/000.json`;
  const manifestPath = `${prefix}/manifest.json`;
  const searchIndex = JSON.parse(fixture.files.get(searchPath)!) as {
    records: Array<Record<string, unknown>>;
  };
  const shard = JSON.parse(fixture.files.get(shardPath)!) as {
    records: Array<Record<string, unknown>>;
  };
  const manifest = JSON.parse(fixture.files.get(manifestPath)!) as Record<
    string,
    unknown
  >;
  const developmentCatalog = {
    id: 'status:latest-development',
    category: 'status',
    kind: 'development_status',
    title: 'Latest Stream development update',
    name: 'latest development status',
    aliases: ['stream development', 'stream progress'],
    searchText:
      'latest current development progress headroom working on before launch',
    recordShard: 0
  };
  const developmentEvidence = {
    ...developmentCatalog,
    canonicalPath: `/reviews/${REVIEW_ID}#development-update`,
    summary:
      'The permanent Core now meets its size target. Stream is being prepared for external audit and launch evidence.',
    provenance: {
      reviewVersion: VERSION,
      sourceCommit: '5021c8060950c3fef995271e674ed4b2007fee6d',
      sourcePath: 'config/public-reviews/6529-stream.development-status.json'
    },
    structured: {
      checkedAt: '2026-08-01T00:00:00.000Z',
      state: 'PRE_AUDIT_DEVELOPMENT',
      headline:
        'The permanent Core now meets its size target. Stream is being prepared for external audit and launch evidence.',
      summary: 'Development has continued since the reviewed snapshot.',
      recentlyCompleted: [
        {
          id: 'permanent-core-size',
          text: `The permanent Core fits within Ethereum's contract-size limit with 5,579 bytes of headroom.`,
          evidencePath: 'release-artifacts/latest/bytecode-release-proof.json'
        }
      ],
      workingOn: [
        {
          id: 'launch-configuration',
          text: 'Confirming the exact contract set, permissions, settings, and connections for launch.',
          evidencePath: 'docs/release-readiness.md'
        }
      ],
      beforeLaunch: [
        {
          id: 'public-testnet-rehearsal',
          text: 'Run the public testnet rehearsal and publish the verified addresses and source.',
          evidencePath: 'release-artifacts/latest/public-beta-evidence.json'
        },
        {
          id: 'external-audit',
          text: 'Complete an independent external audit and retest every accepted fix.',
          evidencePath: 'docs/audit-package.md'
        },
        {
          id: 'launch-records',
          text: 'Approve the final settings, deployment records, and operating rehearsals.',
          evidencePath: 'docs/release-readiness.md'
        }
      ]
    },
    relationships: { relatedEditorialIds: [] }
  };
  const staleRiskCatalog = {
    id: 'risk:current-implementation-and-readiness:RISK-SIZE-001',
    category: 'status',
    kind: 'risk_register_entry',
    title: 'Historical contract size snapshot',
    name: 'contract size',
    aliases: ['contract size', 'headroom'],
    searchText:
      'contract size headroom launch blocker reviewed version historical snapshot 424 bytes',
    recordShard: 0
  };
  const staleRiskEvidence = {
    ...staleRiskCatalog,
    canonicalPath: `/reviews/${REVIEW_ID}/versions/${VERSION}/current-implementation-and-readiness`,
    summary:
      'The reviewed snapshot had 424 bytes of EIP-170 headroom and was 1,576 bytes below the release gate.',
    provenance: { reviewVersion: VERSION, sourceCommit: COMMIT },
    relationships: { relatedEditorialIds: [] }
  };
  searchIndex.records.push(developmentCatalog, staleRiskCatalog);
  shard.records.push(developmentEvidence, staleRiskEvidence);
  const searchText = JSON.stringify(searchIndex);
  const shardText = JSON.stringify(shard);
  const searchManifest = manifest.searchIndex as Record<string, unknown>;
  searchManifest.sha256 = sha256(searchText);
  searchManifest.recordCount = searchIndex.records.length;
  const shardManifest = (
    manifest.recordShards as Array<Record<string, unknown>>
  )[0]!;
  shardManifest.sha256 = sha256(shardText);
  shardManifest.recordCount = shard.records.length;
  (manifest.counts as Record<string, unknown>).total =
    searchIndex.records.length;
  delete manifest.knowledgeSha256;
  manifest.knowledgeSha256 = sha256(stableJson(manifest));
  fixture.files.set(searchPath, searchText);
  fixture.files.set(shardPath, shardText);
  fixture.files.set(manifestPath, JSON.stringify(manifest));
  return fixture;
}

describe('FrontendStreamKnowledgeSource', () => {
  it('canonicalizes object keys with frontend-compatible code-unit ordering', () => {
    expect(
      STREAM_KNOWLEDGE_TESTING.stableJson({
        _supporting: true,
        Zebra: true,
        alpha: true
      })
    ).toBe('{\n  "Zebra": true,\n  "_supporting": true,\n  "alpha": true\n}\n');
  });

  it('keeps boundary-sized evidence packets within the hard budget', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: 0,
          max: STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_METADATA_CHARACTERS
        }),
        fc.array(
          fc.stringOf(fc.constantFrom('a', ' '), {
            minLength: 0,
            maxLength: STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_RECORD_CHARACTERS
          }),
          {
            minLength: STREAM_KNOWLEDGE_TESTING.MIN_EVIDENCE_RECORDS,
            maxLength: STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_RECORDS
          }
        ),
        (prefixCharacters, records) => {
          const selected =
            STREAM_KNOWLEDGE_TESTING.selectBoundedEvidenceRecords(
              records,
              prefixCharacters
            );
          const characters =
            prefixCharacters +
            selected.reduce((total, record) => total + record.length, 0);

          expect(characters).toBeLessThanOrEqual(
            STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_PACKET_CHARACTERS
          );
          expect(selected.length).toBeGreaterThanOrEqual(
            STREAM_KNOWLEDGE_TESTING.MIN_EVIDENCE_RECORDS
          );
        }
      )
    );
  });

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

  it('isolates the latest development update from historical snapshot status', async () => {
    const fixture = addDevelopmentStatusFixture(buildFixture());
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    const match = await source.findMatch(
      'According to the current Stream development update, what is the contract-size headroom and what remains before launch?'
    );
    const evidence = (match?.record.facts ?? [])
      .filter((fact) => fact.startsWith('{'))
      .map((fact) => JSON.parse(fact) as Record<string, unknown>);
    const structured = evidence[0]?.structured as {
      readonly beforeLaunch?: readonly unknown[];
    };

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.id).toBe('status:latest-development');
    expect(match?.record.tags).toContain('development_status');
    expect(match?.record.facts.join('\n')).toContain('5,579 bytes');
    expect(structured.beforeLaunch).toHaveLength(3);
    expect(match?.record.facts.join('\n')).not.toContain('RISK-SIZE-001');
    expect(match?.record.facts.join('\n')).not.toContain('424 bytes');
    expect(match?.record.facts.join('\n')).not.toContain('1,576 bytes');
  });

  it.each([
    'what was the Stream headroom in the pinned snapshot?',
    'what remains before launch for the reviewed Stream version?'
  ])(
    'keeps historical status questions on snapshot evidence: %s',
    async (question) => {
      const fixture = addDevelopmentStatusFixture(buildFixture());
      const source = new FrontendStreamKnowledgeSource(
        fixture.fetcher,
        BASE_URL
      );

      const match = await source.findMatch(question);

      expect(match?.record.facts.join('\n')).toContain('RISK-SIZE-001');
      expect(match?.record.facts.join('\n')).not.toContain(
        'status:latest-development'
      );
    }
  );

  it('does not route an unscoped headroom question into Stream', async () => {
    const fixture = addDevelopmentStatusFixture(buildFixture());
    const source = new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL);

    await expect(source.findMatch('what is the headroom?')).resolves.toBeNull();
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
      const signatureIndex = evidence.indexOf(signature);
      const saleModesIndex = evidence.indexOf('sale-modes');

      expect(signatureIndex).toBeGreaterThanOrEqual(0);
      expect(evidence).toContain(discriminator);
      expect(saleModesIndex).toBeGreaterThanOrEqual(0);
      expect(signatureIndex).toBeLessThan(saleModesIndex);
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
    const protocolIndex = evidence.indexOf(
      'StreamAuctions.withdrawBidderCredit()'
    );
    const testHarnessIndex = evidence.indexOf(
      'AuctionConsistencyInvariantHandler.withdrawBidderCredit(uint256)'
    );

    expect(evidence).not.toContain('AMBIGUITY:');
    expect(protocolIndex).toBeGreaterThanOrEqual(0);
    expect(testHarnessIndex).toBeGreaterThanOrEqual(0);
    expect(protocolIndex).toBeLessThan(testHarnessIndex);
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
    expect(
      new Set(
        evidence.map(
          (fact) =>
            (JSON.parse(fact) as { readonly category?: string }).category
        )
      )
    ).toContain('status');
    expect((match?.record.facts ?? []).join('').length).toBeLessThanOrEqual(
      STREAM_KNOWLEDGE_TESTING.MAX_EVIDENCE_PACKET_CHARACTERS
    );
  });

  it('keeps the body read inside the fetch timeout', async () => {
    const originalFetch = global.fetch;
    const fetchMock: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted'))
            );
          })
      } as unknown as Response;
    };
    global.fetch = fetchMock;
    try {
      await expect(
        STREAM_KNOWLEDGE_TESTING.fetchWithTimeout(
          'https://frontend.example/slow.json',
          5
        )
      ).rejects.toThrow('aborted');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects manifests above explicit catalog and shard-count caps', async () => {
    const manifestPath = `/review-data/${REVIEW_ID}/versions/${VERSION}/knowledge/manifest.json`;
    for (const mutate of [
      (manifest: Record<string, unknown>) => {
        const searchIndex = manifest.searchIndex as Record<string, unknown>;
        const counts = manifest.counts as Record<string, unknown>;
        searchIndex.recordCount =
          STREAM_KNOWLEDGE_TESTING.MAX_CATALOG_RECORDS + 1;
        counts.total = STREAM_KNOWLEDGE_TESTING.MAX_CATALOG_RECORDS + 1;
      },
      (manifest: Record<string, unknown>) => {
        const shards = manifest.recordShards as Array<Record<string, unknown>>;
        const template = shards[0]!;
        manifest.recordShards = Array.from(
          { length: STREAM_KNOWLEDGE_TESTING.MAX_RECORD_SHARDS + 1 },
          (_value, index) => ({
            ...template,
            path: String(template.path).replace(
              '000.json',
              `${String(index).padStart(3, '0')}.json`
            )
          })
        );
      }
    ]) {
      const fixture = buildFixture();
      const manifest = JSON.parse(fixture.files.get(manifestPath)!) as Record<
        string,
        unknown
      >;
      mutate(manifest);
      delete manifest.knowledgeSha256;
      manifest.knowledgeSha256 = sha256(stableJson(manifest));
      fixture.files.set(manifestPath, JSON.stringify(manifest));

      await expect(
        new FrontendStreamKnowledgeSource(fixture.fetcher, BASE_URL).findMatch(
          'what is stream?'
        )
      ).resolves.toBeNull();
    }
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
