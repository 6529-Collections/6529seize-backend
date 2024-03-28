import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import {
  Drop,
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import {
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_TABLE
} from '../constants';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../api-serverless/src/community-members/community-member-criteria.service';

export class DropsDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly criteriaService: CommunityMemberCriteriaService
  ) {
    super(supplyDb);
  }

  async getDropsByIds(ids: number[]): Promise<Drop[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute(`select * from ${DROPS_TABLE} where id in (:ids)`, {
      ids
    });
  }

  public async lockDrop(
    id: number,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select id from ${DROPS_TABLE} where id = :id for update`,
        { id },
        { wrappedConnection: connection }
      )
      .then((it) => it[0].id ?? null);
  }

  async insertDrop(
    newDropEntity: NewDropEntity,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    await this.db.execute(
      `insert into ${DROPS_TABLE} (
                            author_id, 
                            created_at, 
                            title, 
                            content, 
                            quoted_drop_id,
                            media_url, 
                            media_mime_type,
                            root_drop_id,
                            storm_sequence
    ) values (
              :author_id,
              ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000), 
              :title, 
              :content, 
              :quoted_drop_id, 
              :media_url, 
              :media_mime_type,
              :root_drop_id,
              :storm_sequence
             )`,

      newDropEntity,
      { wrappedConnection: connection }
    );
    return await this.getLastInsertId(connection);
  }

  async insertMentions(
    mentions: Omit<DropMentionEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const mention of mentions) {
      await this.db.execute(
        `insert into ${DROPS_MENTIONS_TABLE} (
                            drop_id, 
                            mentioned_profile_id,
                            handle_in_content
    ) values (
              :drop_id, 
              :mentioned_profile_id,
              :handle_in_content
   )`,
        mention,
        { wrappedConnection: connection }
      );
    }
  }

  async insertReferencedNfts(
    references: Omit<DropReferencedNftEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const reference of references) {
      await this.db.execute(
        `insert into ${DROP_REFERENCED_NFTS_TABLE} (
                            drop_id, 
                            contract,
                            token,
                            name
    ) values (
              :drop_id, 
              :contract,
              :token,
              :name
             )`,
        reference,
        { wrappedConnection: connection }
      );
    }
  }

  async insertDropMetadata(
    metadatas: Omit<DropMetadataEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const metadata of metadatas) {
      await this.db.execute(
        `insert into ${DROP_METADATA_TABLE} (
                            drop_id, 
                            data_key,
                            data_value
    ) values (
              :drop_id, 
              :data_key,
              :data_value
             )`,
        metadata,
        { wrappedConnection: connection }
      );
    }
  }

  async findDropById(
    id: number,
    connection?: ConnectionWrapper<any>
  ): Promise<(Drop & { max_storm_sequence: number }) | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        with mss as (select max(d.storm_sequence) as storm_sequence  from ${DROPS_TABLE} d where d.id = :id)
        select d.*, ifnull(mss.storm_sequence, 1) as max_storm_sequence from ${DROPS_TABLE} d left join mss on true where d.id = :id
        `,
        { id },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findRootDropMaxStormSequenceOrZero(
    param: { root_drop_id: number; author_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select ifnull(max(storm_sequence), 0) storm_sequence from ${DROPS_TABLE} where root_drop_id = :root_drop_id and author_id = :authorId`,
        param,
        { wrappedConnection: connection }
      )
      .then((it) => it[0]!.storm_sequence as number);
  }

  async findLatestDropsGroupedInStorms({
    amount,
    id_less_than,
    curation_criteria_id,
    root_drop_id
  }: {
    curation_criteria_id: string | null;
    id_less_than: number | null;
    root_drop_id: number | null;
    amount: number;
  }): Promise<(Drop & { max_storm_sequence: number })[]> {
    const sqlAndParams = await this.criteriaService.getSqlAndParamsByCriteriaId(
      curation_criteria_id
    );
    if (!sqlAndParams) {
      return [];
    }
    const idLessThan = id_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${
      sqlAndParams.sql
    }, mss as (select root_drop_id, max(d.storm_sequence) as max_storm_sequence  from ${DROPS_TABLE} d group by 1)
     select d.*, ifnull(mss.max_storm_sequence, 1) as max_storm_sequence from ${DROPS_TABLE} d
         join ${
           CommunityMemberCriteriaService.GENERATED_VIEW
         } cm on cm.profile_id = d.author_id
         left join mss on mss.root_drop_id = d.id
         where ${
           root_drop_id === null
             ? ' d.root_drop_id is null '
             : ' (d.root_drop_id = :rootDropId or id = :rootDropId) '
         } and id < :idLessThan order by d.id desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      idLessThan
    };
    if (root_drop_id !== null) {
      params.rootDropId = root_drop_id;
    }
    return this.db.execute(sql, params);
  }

  async findProfileRootDrops(param: {
    amount: number;
    id_less_than: number | null;
    profile_id: string;
  }): Promise<(Drop & { max_storm_sequence: number })[]> {
    const idLessThan = param.id_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `
         with mss as (select root_drop_id, max(d.storm_sequence) as max_storm_sequence  from ${DROPS_TABLE} d  group by 1)
         select d.*, ifnull(mss.max_storm_sequence, 1) from ${DROPS_TABLE} d
         left join mss on mss.root_drop_id = d.id
         where d.root_drop_id is null and d.id < :idLessThan and d.author_id = :profileId
         order by d.id desc limit ${param.amount}`;
    return this.db.execute(sql, { profileId: param.profile_id, idLessThan });
  }

  async findMentionsByDropIds(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropMentionEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROPS_MENTIONS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findReferencedNftsByDropIds(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropReferencedNftEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_REFERENCED_NFTS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findMetadataByDropIds(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropMetadataEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_METADATA_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export type NewDropEntity = Omit<Drop, 'id' | 'created_at'>;

export const dropsDb = new DropsDb(dbSupplier, communityMemberCriteriaService);
