import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
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
  DROP_STORMS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_TABLE
} from '../constants';

export class DropsDb extends LazyDbAccessCompatibleService {
  async getDropsByIds(ids: number[]): Promise<Drop[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute(`select * from ${DROPS_TABLE} where id in (:ids)`, {
      ids
    });
  }

  private async createStorm(
    authorProfileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `insert into ${DROP_STORMS_TABLE} (author_profile_id) values (:authorProfileId)`,
        { authorProfileId },
        { wrappedConnection: connection }
      )
      .then(() => this.getLastInsertId(connection));
  }

  private async lockStorm(
    id: number,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select id from ${DROP_STORMS_TABLE} where id = :id for update`,
        { id },
        { wrappedConnection: connection }
      )
      .then((it) => it[0].id ?? null);
  }

  async insertDrop(
    newDropEntity: NewDropEntity,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    let stormId = newDropEntity.storm_id;
    if (stormId === null) {
      stormId = await this.createStorm(newDropEntity.author_id, connection);
    }
    const lockedStormId = await this.lockStorm(stormId, connection);
    const newDropStormSeq = await this.countStormDrops(
      stormId,
      newDropEntity.author_id,
      connection
    ).then((it) => it + 1);
    await this.db.execute(
      `insert into ${DROPS_TABLE} (
                            author_id, 
                            created_at, 
                            title, 
                            content, 
                            quoted_drop_id,
                            media_url, 
                            media_mime_type,
                            storm_id,
                            storm_sequence
    ) values (
              :author_id,
              ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000), 
              :title, 
              :content, 
              :quoted_drop_id, 
              :media_url, 
              :media_mime_type,
              :storm_id,
              :storm_sequence
             )`,
      {
        ...newDropEntity,
        storm_id: lockedStormId,
        storm_sequence: newDropStormSeq
      },
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
  ): Promise<Drop | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        select * from ${DROPS_TABLE} d
        where d.id = :id group by 1`,
        { id },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findMentionsByDropId(
    dropId: number,
    connection?: ConnectionWrapper<any>
  ): Promise<DropMentionEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${DROPS_MENTIONS_TABLE} where drop_id = :dropId`,
      { dropId },
      opts
    );
  }

  async findMetadataByDropId(
    dropId: number,
    connection?: ConnectionWrapper<any>
  ): Promise<DropMetadataEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${DROP_METADATA_TABLE} where drop_id = :dropId`,
      { dropId },
      opts
    );
  }

  async findReferencedNftsByDropId(
    dropId: number,
    connection?: ConnectionWrapper<any>
  ): Promise<DropReferencedNftEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${DROP_REFERENCED_NFTS_TABLE} where drop_id = :dropId`,
      { dropId },
      opts
    );
  }

  async countStormDrops(
    stormId: number,
    authorId: string,
    connection?: ConnectionWrapper<any>
  ) {
    return this.db
      .execute(
        `select count(*) as cnt from ${DROPS_TABLE} where storm_id = :stormId and author_id = :authorId`,
        { stormId, authorId },
        { wrappedConnection: connection }
      )
      .then((it) => it[0].cnt);
  }

  async findLatestDrops(amount: number): Promise<Drop[]> {
    return this.db.execute(
      `select * from ${DROPS_TABLE} order by created_at desc limit ${amount}`
    );
  }

  async findMentionsByDropIds(dropIds: number[]): Promise<DropMentionEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROPS_MENTIONS_TABLE} where drop_id in (:dropIds)`,
      { dropIds }
    );
  }

  async findReferencedNftsByDropIds(
    dropIds: number[]
  ): Promise<DropReferencedNftEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_REFERENCED_NFTS_TABLE} where drop_id in (:dropIds)`,
      { dropIds }
    );
  }

  async findMetadataByDropIds(
    dropIds: number[]
  ): Promise<DropMetadataEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_METADATA_TABLE} where drop_id in (:dropIds)`,
      { dropIds }
    );
  }
}

export interface NewDropEntity
  extends Omit<Drop, 'id' | 'created_at' | 'storm_sequence' | 'storm_id'> {
  readonly storm_id: number | null;
}

export const dropsDb = new DropsDb(dbSupplier);
