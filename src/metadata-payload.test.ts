import { normalizeMetadataPayload } from '@/metadata-payload';

describe('normalizeMetadataPayload', () => {
  it('parses stringified animation_details objects into objects', () => {
    expect(
      normalizeMetadataPayload({
        name: 'The Network',
        animation_details: '{ "format": "HTML" }'
      })
    ).toEqual({
      name: 'The Network',
      animation_details: {
        format: 'HTML'
      }
    });
  });

  it('preserves animation_details when already an object', () => {
    expect(
      normalizeMetadataPayload({
        name: 'The Network',
        animation_details: {
          format: 'HTML'
        }
      })
    ).toEqual({
      name: 'The Network',
      animation_details: {
        format: 'HTML'
      }
    });
  });

  it('parses top-level string payloads and normalizes nested animation_details', () => {
    expect(
      normalizeMetadataPayload(
        JSON.stringify({
          name: 'The Network',
          animation_details: '{ "format": "HTML" }'
        })
      )
    ).toEqual({
      name: 'The Network',
      animation_details: {
        format: 'HTML'
      }
    });
  });
});
