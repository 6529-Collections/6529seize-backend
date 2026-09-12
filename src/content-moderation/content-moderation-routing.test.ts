import { RESERVED_HANDLES } from '@/api-serverless/src/profiles/profiles.constants';
import { CMS_RESERVED_APP_ROUTE_ROOTS } from '@/profile-cms/protocol/v1/constants';

describe('content moderation application route', () => {
  it.each(['content-moderation', 'content_moderation', 'contentmoderation'])(
    'reserves the %s profile handle variant',
    (handle) => {
      expect(RESERVED_HANDLES).toContain(handle);
    }
  );

  it.each(['content-moderation', 'content_moderation', 'contentmoderation'])(
    'reserves the %s CMS route root variant',
    (routeRoot) => {
      expect(CMS_RESERVED_APP_ROUTE_ROOTS).toContain(routeRoot);
    }
  );
});
