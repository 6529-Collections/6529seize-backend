import {
  assertCmsAgentJsonBounded,
  validateCmsAgentCandidate,
  CMS_AGENT_MAX_BYTES
} from './profile-cms-agent-candidate';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';
import {
  computeCmsPackageHash,
  validateCmsPackageV1
} from '@/profile-cms/protocol/v1';

describe('full-package CMS agent candidates', () => {
  it('supports all pages, normalizes hashes, clears publication evidence and preserves the base', () => {
    const base = createValidProfileCmsPackage();
    const input = structuredClone(base);
    const second = structuredClone(input.payload.pages[0]);
    second.id = 'second-page';
    second.path = `/${base.profile.handle}/process/index.html`;
    second.metadata.title = 'Process';
    second.metadata.canonical_url = `https://6529.io/${base.profile.handle}/process`;
    second.blocks = [
      {
        id: 'process-text',
        block_type: 'rich_text',
        text: 'A complete second page.'
      }
    ];
    input.payload.pages.push(second);
    input.payload.routes.push({
      kind: 'page',
      page_id: second.id,
      path: second.path
    });
    input.payload.navigation[0].items.push({
      label: 'Process',
      page_id: second.id
    });
    if (input.payload.build_manifest)
      input.payload.build_manifest.route_count = input.payload.routes.length;
    input.signatures = [
      {
        type: 'eip712',
        signature: '0xsigned-old-content',
        signer: base.profile.primary_wallet!,
        signed_at: new Date(0).toISOString()
      }
    ];
    const result = validateCmsAgentCandidate(base, input, 1000);
    expect(result.valid).toBe(true);
    expect(result.candidate_package.payload.pages).toHaveLength(2);
    expect(result.candidate_package_hash).toBe(
      computeCmsPackageHash(result.candidate_package)
    );
    expect(result.candidate_package_hash).not.toBe(base.integrity.package_hash);
    expect(result.candidate_package.signatures).toEqual([
      {
        type: 'fixture',
        signer: 'fixture',
        signature: 'fixture',
        signed_at: new Date(1000).toISOString()
      }
    ]);
    expect(result.candidate_package.storage).toEqual([
      {
        provider: 'fixture',
        uri: 'https://6529.io/profile-cms/draft',
        content_hash: result.candidate_package_hash,
        canonical: false,
        recorded_at: new Date(1000).toISOString()
      }
    ]);
    expect(
      validateCmsPackageV1(result.candidate_package, { enforceHashes: true })
        .valid
    ).toBe(true);
    expect(base.payload.pages).toHaveLength(1);
    expect(input.signatures[0].type).toBe('eip712');
  });

  it.each(['profile', 'package_id', 'base_path', 'assets'])(
    'rejects changes to protected %s',
    (field) => {
      const base = createValidProfileCmsPackage();
      const input = structuredClone(base);
      if (field === 'profile') input.profile.handle = 'different';
      if (field === 'package_id') input.package_id = 'different';
      if (field === 'base_path') input.site.base_path = '/different/index.html';
      if (field === 'assets')
        input.payload.assets.push({
          id: 'new-asset',
          kind: 'image',
          uri: 'https://example.com/new.png',
          mime_type: 'image/png',
          content_hash: base.integrity.package_hash,
          width: 10,
          height: 10
        });
      expect(() => validateCmsAgentCandidate(base, input, 1000)).toThrow();
    }
  );

  it('returns validation failures for unsafe links without fetching a URL', () => {
    const base = createValidProfileCmsPackage();
    const input = structuredClone(base);
    input.payload.navigation[0].items = [
      { label: 'Unsafe', url: 'javascript:alert(1)' }
    ];
    const result = validateCmsAgentCandidate(base, input, 1000);
    expect(result.valid).toBe(false);
    expect(
      result.validation.issues.some((issue) => issue.severity === 'error')
    ).toBe(true);
  });

  it('bounds bytes, recursion and unsafe property names before schema parsing', () => {
    expect(() =>
      assertCmsAgentJsonBounded({ content: 'x'.repeat(CMS_AGENT_MAX_BYTES) })
    ).toThrow();
    let deep: unknown = {};
    for (let index = 0; index < 34; index++) deep = { child: deep };
    expect(() => assertCmsAgentJsonBounded(deep)).toThrow();
    expect(() =>
      assertCmsAgentJsonBounded(JSON.parse('{"__proto__":{}}'))
    ).toThrow();
  });
});
