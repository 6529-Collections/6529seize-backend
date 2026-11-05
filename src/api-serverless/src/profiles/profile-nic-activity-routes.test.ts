import 'reflect-metadata';
// Preserve Passport's real prototype methods through ts-jest's namespace
// interop; authentication and JWT verification still run normally.
jest.mock('passport', () => {
  const actual = jest.requireActual<typeof import('passport')>('passport');
  return {
    __esModule: true,
    default: actual,
    authenticate: actual.authenticate.bind(actual),
    initialize: actual.initialize.bind(actual),
    use: actual.use.bind(actual)
  };
});
import express, { ErrorRequestHandler } from 'express';
import * as passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import * as jwt from 'jsonwebtoken';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { describeWithSeed } from '@/tests/_setup/seed';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { identitiesDb } from '@/identities/identities.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { Timer } from '@/time';
import { ApiCompliantException } from '@/exceptions';
import router from './profile-activity-logs.routes';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { ApiProfileActivityLog } from './profile-activity-logs-api.service';
import { CountlessPage } from '@/api/page-request';

const secret = 'disposable-nic-test-signing-key';
const wave = aWave({});
const rows = [
  { id: 'handle', type: 'HANDLE_EDIT', matter: null },
  { id: 'cic', type: 'RATING_EDIT', matter: 'CIC' },
  { id: 'rep', type: 'RATING_EDIT', matter: 'REP' },
  { id: 'wave-rep', type: 'RATING_EDIT', matter: 'WAVE_REP' },
  { id: 'picture', type: 'PFP_EDIT', matter: null }
].map((row, i) => ({
  id: row.id,
  profile_id: 'owner',
  target_id: row.matter === 'WAVE_REP' ? wave.id : 'visitor',
  type: row.type,
  additional_data_1: row.matter,
  contents: JSON.stringify({ rating_matter: row.matter }),
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i))
}));

describeWithSeed(
  'NIC profile logs HTTP contract',
  [withWaves([wave]), { table: PROFILES_ACTIVITY_LOGS_TABLE, rows }],
  () => {
    let server: Server;
    let origin: string;
    beforeEach(async () => {
      jest
        .spyOn(identitiesDb, 'getProfileIdByIdentityKeyFast')
        .mockImplementation(async ({ identityKey }) => identityKey);
      jest
        .spyOn(identitiesDb, 'getProfileIdByWallet')
        .mockImplementation(async (wallet) => wallet);
      jest
        .spyOn(identitiesDb, 'getProfileHandlesByIds')
        .mockResolvedValue({ owner: 'owner', visitor: 'visitor' });
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
      jest
        .spyOn(Timer, 'getFromRequest')
        .mockReturnValue(new Timer('nic-http-test'));
      passport.use(
        new JwtStrategy(
          {
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: secret,
            algorithms: ['HS256']
          },
          (payload, done) => done(null, { wallet: payload.sub, role: null })
        )
      );
      passport.use(new AnonymousStrategy());
      const app = express();
      app.use(passport.initialize());
      app.use('/profile-logs', router);
      const errors: ErrorRequestHandler = (error, _req, res, _next) =>
        res
          .status(
            error instanceof ApiCompliantException ? error.getStatusCode() : 500
          )
          .json({ error: error.message });
      app.use(errors);
      server = await new Promise<Server>((resolve) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
      });
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      jest.restoreAllMocks();
    });
    async function get(query: string, viewer?: string) {
      const headers: Record<string, string> = viewer
        ? {
            Authorization: `Bearer ${jwt.sign({ sub: viewer }, secret, { algorithm: 'HS256', expiresIn: 60 })}`
          }
        : {};
      return fetch(`${origin}/profile-logs?${query}`, { headers });
    }
    it.each([undefined, 'visitor', 'owner'])(
      'keeps identity and NIC entries for viewer %s through real authentication, route, service and SQL',
      async (viewer) => {
        const query = 'profile=owner&activity_scope=NIC&page_size=2';
        const first = await get(query, viewer);
        expect(first.status).toBe(200);
        const page = (await first.json()) as {
          page: number;
          next: boolean;
          next_cursor: string;
          data: ApiProfileActivityLog[];
        };
        expect(page.data.map((log) => log.id)).toEqual(['picture', 'cic']);
        expect(page.next).toBe(true);
        expect(page.data).toHaveLength(2);
        expect(page.next_cursor).toEqual(expect.any(String));
        const second = await get(
          `${query}&page=2&cursor=${page.next_cursor}`,
          viewer
        );
        const end =
          (await second.json()) as CountlessPage<ApiProfileActivityLog>;
        expect(second.status).toBe(200);
        expect(end.data.map((log: ApiProfileActivityLog) => log.id)).toEqual([
          'handle'
        ]);
        expect(end).toMatchObject({ page: 2, next: false, next_cursor: null });
        expect(page.data[0]).not.toHaveProperty('nic_cursor_created_at');
        expect(
          (
            await get(
              `${query}&page=2&cursor=${page.next_cursor}&log_type=HANDLE_EDIT`,
              viewer
            )
          ).status
        ).toBe(400);
      }
    );
    it('retries the same cursor concurrently and returns a full final page consistently', async () => {
      const query = 'profile=owner&activity_scope=NIC&page_size=2';
      const first = (await (await get(query, 'owner')).json()) as {
        next_cursor: string;
      };
      const next = `${query}&page=2&cursor=${first.next_cursor}`;
      const responses = await Promise.all([
        get(next, 'owner'),
        get(next, 'owner')
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const pages = await Promise.all(
        responses.map((response) => response.json())
      );
      expect(pages[0]).toEqual(pages[1]);
      expect(pages[0]).toMatchObject({
        page: 2,
        next: false,
        next_cursor: null
      });
      const final = (await (
        await get('profile=owner&activity_scope=NIC&page_size=3')
      ).json()) as CountlessPage<ApiProfileActivityLog>;
      expect(final.data).toHaveLength(3);
      expect(final).toMatchObject({ next: false, next_cursor: null });
    });
    it('keeps missing-profile history empty and rejects non-string cursors', async () => {
      jest
        .spyOn(identitiesDb, 'getProfileIdByIdentityKeyFast')
        .mockResolvedValue(null);
      const response = await get(
        'profile=missing&activity_scope=NIC&page_size=2'
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: [],
        next: false,
        next_cursor: null
      });
      expect(
        (
          await get(
            'profile=owner&activity_scope=NIC&page_size=2&cursor=x&cursor=y'
          )
        ).status
      ).toBe(400);
    });
    it('keeps incoming, cleared/selected log types, legacy All, REP, wave REP and network requests distinct', async () => {
      const incoming = (await (
        await get(
          'target=visitor&activity_scope=NIC&page_size=10&log_type=HANDLE_EDIT'
        )
      ).json()) as CountlessPage<ApiProfileActivityLog>;
      expect(incoming.data.map((log: ApiProfileActivityLog) => log.id)).toEqual(
        ['handle']
      );
      for (const query of [
        'profile=owner&page_size=10',
        'profile=owner&page_size=10&rating_matter=REP',
        'target=' + wave.id + '&rating_matter=WAVE_REP&page_size=10',
        'page_size=10'
      ]) {
        const response = await get(query);
        expect(response.status).toBe(200);
        const body =
          (await response.json()) as CountlessPage<ApiProfileActivityLog>;
        expect(body).not.toHaveProperty('next_cursor');
        expect(
          body.data.some((log: ApiProfileActivityLog) =>
            ['rep', 'wave-rep'].includes(log.id)
          )
        ).toBe(true);
      }
    });
    it('rejects missing cursors and unsupported NIC combinations', async () => {
      for (const query of [
        'activity_scope=NIC&page_size=10',
        'activity_scope=NIC&profile=owner&page=2&page_size=10',
        'activity_scope=NIC&profile=owner&rating_matter=CIC&page_size=10',
        'profile=owner&cursor=bad'
      ])
        expect((await get(query)).status).toBe(400);
    });
  }
);
