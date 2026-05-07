import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class VideoMeta extends Model {
  static table = 'video_meta';

  @field('video_id') videoId!: string;
  @field('playlist_id') playlistId!: string;
  @field('title') title!: string;
  @field('author') author!: string | null;
  @field('cover') cover!: string | null;
  @field('duration') duration!: number | null;
  @field('publish_time') publishTime!: number | null;
  @field('random_weight') randomWeight!: number | null;
  @field('is_cached') isCached!: boolean;
  @field('is_deleted') isDeleted!: boolean;
  @field('extra_json') extraJson!: string | null;
  @date('synced_at') syncedAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
