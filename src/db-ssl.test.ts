import fc from 'fast-check';
import { getMysqlSslOptions, mysqlSslConnectionOptions } from './db-ssl';

describe('getMysqlSslOptions', () => {
  it('keeps TLS off when DB_SSL is unset', () => {
    expect(getMysqlSslOptions({})).toBeUndefined();
    expect(mysqlSslConnectionOptions({})).toEqual({});
  });

  it('keeps TLS off for every value other than true', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => value.trim().toLowerCase() !== 'true'),
        (value) => {
          const readCaFile = jest.fn();
          expect(
            getMysqlSslOptions(
              { DB_SSL: value, DB_SSL_CA_FILE: '/ca.pem' },
              readCaFile
            )
          ).toBeUndefined();
          expect(readCaFile).not.toHaveBeenCalled();
        }
      )
    );
  });

  it.each(['true', 'TRUE', ' true '])(
    'verifies the server certificate when DB_SSL=%j',
    (value) => {
      expect(getMysqlSslOptions({ DB_SSL: value })).toEqual({
        rejectUnauthorized: true
      });
      expect(mysqlSslConnectionOptions({ DB_SSL: value })).toEqual({
        ssl: { rejectUnauthorized: true }
      });
    }
  );

  it('adds the configured CA bundle', () => {
    const readCaFile = jest.fn().mockReturnValue('PEM');
    expect(
      getMysqlSslOptions(
        { DB_SSL: 'true', DB_SSL_CA_FILE: ' /opt/rds-global-bundle.pem ' },
        readCaFile
      )
    ).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    expect(readCaFile).toHaveBeenCalledWith('/opt/rds-global-bundle.pem');
  });

  it('ignores an empty CA bundle setting', () => {
    const readCaFile = jest.fn();
    expect(
      getMysqlSslOptions({ DB_SSL: 'true', DB_SSL_CA_FILE: '  ' }, readCaFile)
    ).toEqual({ rejectUnauthorized: true });
    expect(readCaFile).not.toHaveBeenCalled();
  });

  it('fails when the configured CA bundle cannot be read', () => {
    expect(() =>
      getMysqlSslOptions({
        DB_SSL: 'true',
        DB_SSL_CA_FILE: '/nonexistent/db-ssl-ca.pem'
      })
    ).toThrow();
  });
});
