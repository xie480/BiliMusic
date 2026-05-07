import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class SyncJob extends Model {
  static table = 'sync_job';

  @field('job_id') jobId!: string;
  @field('playlist_id') playlistId!: string;
  @field('status') status!: string;
  @field('cursor_start') cursorStart!: string | null;
  @field('cursor_end') cursorEnd!: string | null;
  @field('snapshot_revision') snapshotRevision!: string | null;
  @field('synced_count') syncedCount!: number;
  @field('failed_reason') failedReason!: string | null;
  @date('started_at') startedAt!: Date;
  @date('finished_at') finishedAt!: Date | null;
}
