import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 2,
  tables: [
    tableSchema({
      name: 'playlist_meta',
      columns: [
        { name: 'playlist_id', type: 'string', isIndexed: true },
        { name: 'title', type: 'string', isOptional: true },
        { name: 'remote_video_count', type: 'number' },
        { name: 'local_synced_count', type: 'number' },
        { name: 'sync_cursor', type: 'string', isOptional: true },
        { name: 'last_synced_video_id', type: 'string', isOptional: true },
        { name: 'remote_revision', type: 'string', isOptional: true },
        { name: 'sync_status', type: 'string' },
        { name: 'last_synced_at', type: 'number', isOptional: true },
        { name: 'need_resync', type: 'boolean' },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'video_meta',
      columns: [
        { name: 'video_id', type: 'string', isIndexed: true },
        { name: 'playlist_id', type: 'string', isIndexed: true },
        { name: 'title', type: 'string' },
        { name: 'author', type: 'string', isOptional: true },
        { name: 'cover', type: 'string', isOptional: true },
        { name: 'duration', type: 'number', isOptional: true },
        { name: 'publish_time', type: 'number', isOptional: true, isIndexed: true },
        { name: 'random_weight', type: 'number', isOptional: true, isIndexed: true },
        { name: 'is_cached', type: 'boolean' },
        { name: 'is_deleted', type: 'boolean', isIndexed: true },
        { name: 'extra_json', type: 'string', isOptional: true },
        { name: 'synced_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'sync_job',
      columns: [
        { name: 'job_id', type: 'string', isIndexed: true },
        { name: 'playlist_id', type: 'string', isIndexed: true },
        { name: 'status', type: 'string' },
        { name: 'cursor_start', type: 'string', isOptional: true },
        { name: 'cursor_end', type: 'string', isOptional: true },
        { name: 'snapshot_revision', type: 'string', isOptional: true },
        { name: 'synced_count', type: 'number' },
        { name: 'failed_reason', type: 'string', isOptional: true },
        { name: 'started_at', type: 'number' },
        { name: 'finished_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
