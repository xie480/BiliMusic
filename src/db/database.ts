import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import { schema } from './schema';
import { GlobalVideo } from './models/GlobalVideo';
import { SyncMeta } from './models/SyncMeta';

const adapter = new SQLiteAdapter({
  schema,
  // jsi: true, // 可选启用 JSI 加速，需安装 react-native-quick-sqlite
  onSetUpError: (error) => {
    console.error('[DB] Setup error:', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [GlobalVideo, SyncMeta],
});

export const globalVideoCollection = database.get<GlobalVideo>('global_videos');
export const syncMetaCollection = database.get<SyncMeta>('sync_meta');
