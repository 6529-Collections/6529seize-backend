import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  childEnv,
  inheritedEnv,
  preflightProblems
} from '@/rebuild/stack/child-env';

describe('child environment', () => {
  it('inherits only the basics, never keys or AWS settings', () => {
    const env = inheritedEnv({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      TEMP: '/tmp',
      AWS_ACCESS_KEY_ID: 'x',
      AWS_PROFILE: 'x',
      ALCHEMY_API_KEY: 'x',
      DB_PASS: 'x',
      NODE_OPTIONS: '--require evil'
    });
    expect(Object.keys(env).sort((a, b) => a.localeCompare(b))).toEqual([
      'Path',
      'SystemRoot',
      'TEMP'
    ]);
  });

  it('points the app at the run database and away from AWS and Redis', () => {
    const env = childEnv({
      parent: { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x' },
      home: '/run',
      db: {
        host: '127.0.0.1',
        port: 3407,
        user: 'rb_1',
        password: 'pw',
        database: 'rebuild'
      },
      jwtSecret: 'secret',
      extra: { FEATURE_X: 'true' }
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      NODE_ENV: 'local',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3407',
      DB_USER: 'rb_1',
      DB_USER_READ: 'rb_1',
      DB_NAME: 'rebuild',
      FORCE_AVOID_REDIS: 'true',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_SHARED_CREDENTIALS_FILE: path.join('/run', 'no-aws-config'),
      FEATURE_X: 'true'
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('refuses flags that would change the run settings or AWS', () => {
    const build = (extra: Record<string, string>) => () =>
      childEnv({
        parent: {},
        home: '/run',
        db: {
          host: '127.0.0.1',
          port: 3407,
          user: 'u',
          password: 'p',
          database: 'd'
        },
        jwtSecret: 's',
        extra
      });
    expect(build({ DB_USER: 'root' })).toThrow('DB_USER');
    expect(build({ AWS_PROFILE: 'x' })).toThrow('AWS_PROFILE');
    expect(build({ NODE_OPTIONS: '--require x' })).toThrow('NODE_OPTIONS');
    expect(build({ FEATURE_X: 'true' })).not.toThrow();
  });

  it('refuses a local env file and a Lambda marker', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-env-'));
    try {
      expect(preflightProblems(repo, {})).toEqual([]);
      fs.writeFileSync(path.join(repo, '.env.local'), 'X=1');
      expect(
        preflightProblems(repo, { AWS_LAMBDA_FUNCTION_NAME: 'f' })
      ).toHaveLength(2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
