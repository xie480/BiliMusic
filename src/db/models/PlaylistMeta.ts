import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class PlaylistMeta extends Model {
  static table = 'playlist_meta';

  @field('playlist_id') playlistId!: string;
  @field('title') title!: string;
  @field('remote_video_count') remoteVideoCount!: number;
  @field('local_synced_count') localSyncedCount!: number;
  @field('sync_cursor') syncCursor!: string | null;
  @field('last_synced_video_id') lastSyncedVideoId!: string | null;
  @field('remote_revision') remoteRevision!: string | null;
  @field('sync_status') syncStatus!: string;
  @date('last_synced_at') lastSyncedAt!: Date | null;
  @field('need_resync') needResync!: boolean;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
