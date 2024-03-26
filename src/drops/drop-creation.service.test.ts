import { DropCreationService } from './drop-creation.service';
import { DropsService } from './drops.service';
import { DropsDb } from './drops.db';
import { DropFileService } from './drop-file.service';
import { mock } from 'ts-jest-mocker';
import { Profile } from '../entities/IProfile';
import { when } from 'jest-when';
import {
  expectExceptionWithMessage,
  mockConnection,
  mockDbService
} from '../tests/test.helper';

const aProfile: Profile = {
  handle: 'Joe',
  normalised_handle: 'joe',
  external_id: 'pid',
  primary_wallet: '0x0',
  created_by_wallet: '0x0',
  created_at: new Date()
};

const aProfileMin = {
  id: aProfile.external_id,
  handle: aProfile.handle,
  pfp: null,
  cic: 0,
  rep: 0,
  tdh: 0,
  level: 0
};

const aDropFull = {
  // this doesn't matter as we test inserting
  id: 1,
  author: aProfileMin,
  author_archived: false,
  created_at: 0,
  title: 'title',
  content: 'content',
  quoted_drop_id: null,
  referenced_nfts: [],
  mentioned_users: [],
  metadata: [],
  media_url: null,
  media_mime_type: null,
  storm_id: 0,
  storm_sequence: 1,
  max_storm_sequence: 2
};

describe('DropCreationService', () => {
  let dropCreationService: DropCreationService;
  let dropsService: DropsService;
  let dropsDb: DropsDb;
  let dropFileService: DropFileService;

  beforeEach(() => {
    dropsService = mock();
    when(dropsService.findDropByIdOrThrow).mockResolvedValue(aDropFull);
    dropsDb = mockDbService();
    dropFileService = mock();
    dropCreationService = new DropCreationService(
      dropsService,
      dropsDb,
      dropFileService
    );
  });

  it('should create a drop without media', async () => {
    when(dropsDb.insertDrop).mockResolvedValue(1);
    when(dropsDb.countStormDrops).mockResolvedValue(1);
    when(dropsDb.getDropsByIds).mockResolvedValue([
      {
        id: 5,
        author_id: 'pid',
        storm_id: 2,
        storm_sequence: 1,
        quoted_drop_id: null,
        media_url: null,
        media_mime_type: null,
        title: 'title',
        content: 'content',
        created_at: 0
      }
    ]);
    await dropCreationService.createDrop({
      author: aProfile,
      title: 'title',
      content: 'content',
      storm_id: null,
      quoted_drop_id: 5,
      referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
      mentioned_users: [
        { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
      ],
      metadata: [{ data_key: 'key', data_value: 'value' }],
      dropMedia: null
    });
    expect(dropsDb.insertDrop).toHaveBeenCalledWith(
      {
        author_id: aProfile.external_id,
        title: 'title',
        content: 'content',
        storm_id: null,
        quoted_drop_id: 5,
        media_url: null,
        media_mime_type: null
      },
      mockConnection
    );
    expect(dropsDb.insertMentions).toHaveBeenCalledWith(
      [{ drop_id: 1, mentioned_profile_id: 'pid', handle_in_content: 'Joe' }],
      mockConnection
    );
    expect(dropsDb.insertReferencedNfts).toHaveBeenCalledWith(
      [{ drop_id: 1, contract: '0x0', token: '1', name: 'name' }],
      mockConnection
    );
    expect(dropsDb.insertDropMetadata).toHaveBeenCalledWith(
      [{ drop_id: 1, data_key: 'key', data_value: 'value' }],
      mockConnection
    );
  });

  it('should create a drop with media', async () => {
    when(dropsDb.insertDrop).mockResolvedValue(1);
    when(dropFileService.uploadDropMedia).mockResolvedValue({
      media_url: 'media-url',
      media_mime_type: 'media-mime-type'
    });
    await dropCreationService.createDrop({
      author: aProfile,
      title: 'title',
      content: 'content',
      storm_id: null,
      quoted_drop_id: null,
      referenced_nfts: [],
      mentioned_users: [],
      metadata: [],
      dropMedia: {
        stream: Buffer.from(''),
        name: 'name',
        mimetype: 'mimetype',
        size: 0
      }
    });
    expect(dropsDb.insertDrop).toHaveBeenCalledWith(
      {
        author_id: aProfile.external_id,
        title: 'title',
        content: 'content',
        storm_id: null,
        quoted_drop_id: null,
        media_url: 'media-url',
        media_mime_type: 'media-mime-type'
      },
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
        storm_id: null,
        quoted_drop_id: 5,
        referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
        mentioned_users: [
          { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
        ],
        metadata: [{ data_key: 'key', data_value: 'value' }],
        dropMedia: null
      });
    }, 'Invalid quoted drop');
  });

  it('invalid storm id', async () => {
    when(dropsDb.countStormDrops).mockResolvedValue(0);
    await expectExceptionWithMessage(async () => {
      await dropCreationService.createDrop({
        author: aProfile,
        title: 'title',
        content: 'content',
        storm_id: 2,
        quoted_drop_id: null,
        referenced_nfts: [{ contract: '0x0', token: '1', name: 'name' }],
        mentioned_users: [
          { mentioned_profile_id: 'pid', handle_in_content: 'Joe' }
        ],
        metadata: [{ data_key: 'key', data_value: 'value' }],
        dropMedia: null
      });
    }, 'Invalid storm');
  });
});
