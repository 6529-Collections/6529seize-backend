import { toPublicRememeRow } from './rememes.routes';

describe('toPublicRememeRow', () => {
  it('parses JSON columns and drops internal processing diagnostics', () => {
    const row = toPublicRememeRow({
      contract: '0xabc',
      id: '1',
      metadata: '{"name":"x"}',
      media: '{"gateway":"https://example.test/a.png"}',
      contract_opensea_data: '{}',
      meme_references: '[1,2]',
      replicas: '1,2',
      s3_image_processing_status: 'complete',
      s3_image_processing_error:
        'connect ECONNREFUSED 10.0.0.1:443 https://internal.example/path'
    });
    expect(row).toMatchObject({
      metadata: { name: 'x' },
      media: { gateway: 'https://example.test/a.png' },
      meme_references: [1, 2],
      replicas: ['1', '2']
    });
    expect(row).not.toHaveProperty('s3_image_processing_error');
  });
});
