import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'global_videos',
      columns: [
        { name: 'bvid', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'cover', type: 'string' },
        { name: 'duration', type: 'number' },
        { name: 'page', type: 'number' },
        { name: 'pubtime', type: 'number' },
        { name: 'upper_mid', type: 'number' },
        { name: 'upper_name', type: 'string' },
        { name: 'attr', type: 'number' },
        { name: 'folder_ids', type: 'string' },
        { name: 'parts', type: 'string' },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'sync_meta',
      columns: [
        { name: 'folder_id', type: 'number' },
        { name: 'last_sync_time', type: 'number' },
        { name: 'latest_bvid', type: 'string', isOptional: true },
        { name: 'media_count', type: 'number' },
        { name: 'needs_full_sync', type: 'boolean' },
        { name: 'last_synced_page', type: 'number', isOptional: true },
      ],
    }),
  ],
});
