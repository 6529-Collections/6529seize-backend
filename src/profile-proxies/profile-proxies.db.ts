import { PROFILE_PROXIES_TABLE } from '../constants';
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';

export class ProfileProxiesDb extends LazyDbAccessCompatibleService {
  async insertProfileProxy({
    profileProxy,
    connection
  }: {
    readonly profileProxy: ProfileProxyEntity;
    readonly connection: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `insert into ${PROFILE_PROXIES_TABLE} (id, target_id, created_at, created_by_id) values (:id, :target_id, :created_at, :created_by_id)`,
      {
        id: profileProxy.id,
        target_id: profileProxy.target_id,
        created_at: profileProxy.created_at,
        created_by_id: profileProxy.created_by_id
      },
      { wrappedConnection: connection }
    );
  }

  async findProfileProxyById({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `select * from ${PROFILE_PROXIES_TABLE} where id = :id`,
        { id },
        opts
      )
      .then((result) => result[0] ?? null);
  }

  async findProfileProxyByTargetTypeAndIdAndCreatedByProfileId({
    target_id,
    created_by_profile_id,
    connection
  }: {
    readonly target_id: string;
    readonly created_by_profile_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `select * from ${PROFILE_PROXIES_TABLE} where target_id = :target_id and created_by_id = :created_by_id`,
        { target_id, created_by_id: created_by_profile_id },
        opts
      )
      .then((result) => result[0] ?? null);
  }

  async findProfileReceivedProfileProxies({
    target_id,
    page,
    page_size,
    sort,
    sort_direction,
    connection
  }: {
    readonly target_id: string;
    readonly page: number;
    readonly page_size: number;
    readonly sort: string;
    readonly sort_direction: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${PROFILE_PROXIES_TABLE} where target_id = :target_id order by ${sort} ${sort_direction} limit :limit offset :offset`,
      {
        target_id,
        limit: page_size,
        offset: (page - 1) * page_size
      },
      opts
    );
  }

  async countProfileReceivedProfileProxies({
    target_id,
    connection
  }: {
    target_id: string;
    connection?: ConnectionWrapper<any>;
  }): Promise<number> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const dbResult: { cnt: number }[] = await this.db.execute(
      `select count(*) as cnt from ${PROFILE_PROXIES_TABLE} where target_id = :target_id`,
      { target_id },
      opts
    );
    return dbResult.at(0)?.cnt ?? 0;
  }
}

export const profileProxiesDb = new ProfileProxiesDb(dbSupplier);
