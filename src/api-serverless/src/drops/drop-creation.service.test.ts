import { DropCreationApiService } from './drop-creation.api.service';
import { DropsApiService } from './drops.api.service';
import { DropsDb } from '../../../drops/drops.db';
import { mock } from 'ts-jest-mocker';
import { Profile } from '../../../entities/IProfile';
import { when } from 'jest-when';
import {
  expectExceptionWithMessage,
  mockConnection,
  mockDbService
} from '../../../tests/test.helper';
import { ProfileActivityLogsDb } from '../../../profileActivityLogs/profile-activity-logs.db';
import { Drop } from '../generated/models/Drop';
import { ProfileMin } from '../generated/models/ProfileMin';

const aProfile: Profile = {
  handle: 'Joe',
  normalised_handle: 'joe',
  external_id: 'pid',
  primary_wallet: '0x0',
  created_by_wallet: '0x0',
  created_at: new Date()
};

const aProfileMin: ProfileMin = {
  id: aProfile.external_id,
  handle: aProfile.handle,
  cic: 0,
  rep: 0,
  tdh: 0,
  level: 0,
  archived: false
};

const aDrop: Drop & { max_storm_sequence: number } = {
  // this doesn't matter as we test inserting
  id: '123',
  serial_no: 1,
  author: aProfileMin,
  created_at: 0,
  title: 'title',
  content: 'content',
  quoted_drop_id: null,
  referenced_nfts: [],
  mentioned_users: [],
  metadata: [],
  media: [],
  root_drop_id: null,
  storm_sequence: 1,
  max_storm_sequence: 2,
  rating: 0,
  top_raters: [],
  raters_count: 0,
  top_rating_categories: [],
  rating_categories_count: 0,
  context_profile_context: null,
  discussion_comments_count: 0,
  rating_logs_count: 0,
  quotes_count: 0
};

describe('DropCreationService', () => {
  let dropCreationService: DropCreationApiService;
  let dropsService: DropsApiService;
  let dropsDb: DropsDb;
  let profileActivityLogsDb: ProfileActivityLogsDb;

  beforeEach(() => {
    dropsService = mock();
    when(dropsService.findDropByIdOrThrow).mockResolvedValue(aDrop);
    dropsDb = mockDbService();
    profileActivityLogsDb = mock();
    dropCreationService = new DropCreationApiService(
      dropsService,
      dropsDb,
      profileActivityLogsDb
    );
  });

  it('should create a drop without media', async () => {
    when(dropsDb.insertDrop).mockResolvedValue('123');
    when(dropsDb.getDropsByIds).mockResolvedValue([
      {
        id: '123',
        serial_no: 5,
        author_id: 'pid',
        root_drop_id: null,
        storm_sequence: 1,
        quoted_drop_id: null,
        title: 'title',
        content: 'content',
        created_at: 0
      }
    ]);
    await dropCreationService.createDrop({
      author: aProfile,
      title: 'title',
      content: 'content',
      root_drop_id: null,
      quoted_drop_id: '5',
      referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
      mentioned_users: [
        { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
      ],
      metadata: [{ data_key: 'key', data_value: 'value' }],
      media: []
    });
    expect(dropsDb.insertDrop).toHaveBeenCalledWith(
      {
        author_id: aProfile.external_id,
        title: 'title',
        content: 'content',
        root_drop_id: null,
        storm_sequence: 1,
        quoted_drop_id: '5'
      },
      mockConnection
    );
    expect(dropsDb.insertMentions).toHaveBeenCalledWith(
      [
        {
          drop_id: '123',
          mentioned_profile_id: 'pid',
          handle_in_content: 'Joe'
        }
      ],
      mockConnection
    );
    expect(dropsDb.insertReferencedNfts).toHaveBeenCalledWith(
      [{ drop_id: '123', contract: '0x0', token: '1', name: 'name' }],
      mockConnection
    );
    expect(dropsDb.insertDropMetadata).toHaveBeenCalledWith(
      [{ drop_id: '123', data_key: 'key', data_value: 'value' }],
      mockConnection
    );
  });

  it('should fail when quoted drop does not exist', async () => {
    when(dropsDb.getDropsByIds).mockResolvedValue([]);
    await expectExceptionWithMessage(async () => {
      await dropCreationService.createDrop({
        author: aProfile,
        title: 'title',
        content: 'content',
        root_drop_id: null,
        quoted_drop_id: '5',
        referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
        mentioned_users: [
          { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
        ],
        metadata: [{ data_key: 'key', data_value: 'value' }],
        media: []
      });
    }, 'Invalid quoted drop');
  });

  it('invalid root drop id', async () => {
    await expectExceptionWithMessage(async () => {
      await dropCreationService.createDrop({
        author: aProfile,
        title: 'title',
        content: 'content',
        root_drop_id: '123',
        quoted_drop_id: null,
        referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
        mentioned_users: [
          { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
        ],
        metadata: [{ data_key: 'key', data_value: 'value' }],
        media: []
      });
    }, 'Invalid root drop');
  });
});
