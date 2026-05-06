import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class SyncMeta extends Model {
  static table = 'sync_meta';

  @field('folder_id') folderId!: number;
  @readonly @date('last_sync_time') lastSyncTime!: Date;
  @field('latest_bvid') latestBvid!: string | null;
  @field('media_count') mediaCount!: number;
  @field('needs_full_sync') needsFullSync!: boolean;
  @field('last_synced_page') lastSyncedPage!: number | null;
}
