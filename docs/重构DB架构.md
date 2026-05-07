下面给你一套适合 **React Native + WatermelonDB** 的完整方案。
目标：

* 支持大规模收藏夹索引
* 支持断点续传
* 支持增量同步
* 支持同步恢复
* 支持随机播放 / 全局搜索
* 避免全量同步
* 尽量减少 SQLite IO

我会按：

1. 表结构
2. Model
3. 索引设计
4. 同步状态机
5. 核心同步流程
6. 伪代码
7. 性能优化

来写。

---

# 一、WatermelonDB 表结构

---

# 1. 收藏夹元数据表 `playlist_meta`

用于：

* 同步状态
* 增量同步
* 游标记录
* 收藏夹统计

```ts
tableSchema({
  name: 'playlist_meta',
  columns: [
    { name: 'playlist_id', type: 'string', isIndexed: true },

    { name: 'title', type: 'string', isOptional: true },

    // 远端有效视频数
    { name: 'remote_video_count', type: 'number' },

    // 本地已同步数
    { name: 'local_synced_count', type: 'number' },

    // 分页游标
    { name: 'sync_cursor', type: 'string', isOptional: true },

    // 最后同步视频ID
    { name: 'last_synced_video_id', type: 'string', isOptional: true },

    // 远端版本号/快照版本
    { name: 'remote_revision', type: 'string', isOptional: true },

    // idle syncing failed success
    { name: 'sync_status', type: 'string' },

    // 最后同步时间
    { name: 'last_synced_at', type: 'number', isOptional: true },

    // 是否需要强制同步
    { name: 'need_resync', type: 'boolean' },

    { name: 'created_at', type: 'number' },
    { name: 'updated_at', type: 'number' },
  ]
})
```

---

# 2. 视频元数据表 `video_meta`

核心数据表。

```ts
tableSchema({
  name: 'video_meta',
  columns: [
    { name: 'video_id', type: 'string', isIndexed: true },

    { name: 'playlist_id', type: 'string', isIndexed: true },

    { name: 'title', type: 'string' },

    { name: 'author', type: 'string', isOptional: true },

    { name: 'cover', type: 'string', isOptional: true },

    { name: 'duration', type: 'number', isOptional: true },

    { name: 'publish_time', type: 'number', isOptional: true },

    // 用于随机播放权重
    { name: 'random_weight', type: 'number', isOptional: true },

    // 是否已缓存
    { name: 'is_cached', type: 'boolean' },

    // 软删除
    { name: 'is_deleted', type: 'boolean' },

    // JSON扩展字段
    { name: 'extra_json', type: 'string', isOptional: true },

    { name: 'synced_at', type: 'number' },

    { name: 'updated_at', type: 'number' },
  ]
})
```

---

# 3. 同步任务表 `sync_job`

记录同步过程。

```ts
tableSchema({
  name: 'sync_job',
  columns: [
    { name: 'job_id', type: 'string', isIndexed: true },

    { name: 'playlist_id', type: 'string', isIndexed: true },

    // running success failed cancelled
    { name: 'status', type: 'string' },

    { name: 'cursor_start', type: 'string', isOptional: true },

    { name: 'cursor_end', type: 'string', isOptional: true },

    { name: 'snapshot_revision', type: 'string', isOptional: true },

    { name: 'synced_count', type: 'number' },

    { name: 'failed_reason', type: 'string', isOptional: true },

    { name: 'started_at', type: 'number' },

    { name: 'finished_at', type: 'number', isOptional: true },
  ]
})
```

---

# 二、WatermelonDB Model

---

# playlist_meta model

```ts
export default class PlaylistMeta extends Model {
  static table = 'playlist_meta'

  @field('playlist_id') playlistId
  @field('title') title

  @field('remote_video_count') remoteVideoCount
  @field('local_synced_count') localSyncedCount

  @field('sync_cursor') syncCursor
  @field('last_synced_video_id') lastSyncedVideoId

  @field('remote_revision') remoteRevision

  @field('sync_status') syncStatus

  @field('last_synced_at') lastSyncedAt

  @field('need_resync') needResync
}
```

---

# video_meta model

```ts
export default class VideoMeta extends Model {
  static table = 'video_meta'

  @field('video_id') videoId

  @field('playlist_id') playlistId

  @field('title') title

  @field('author') author

  @field('cover') cover

  @field('duration') duration

  @field('publish_time') publishTime

  @field('is_cached') isCached

  @field('is_deleted') isDeleted

  @field('extra_json') extraJson
}
```

---

# 三、关键索引设计（非常重要）

WatermelonDB 本质 SQLite。

索引决定性能。

必须建立：

---

## 视频表

### 1. video_id

用于：

* 去重
* 更新

```sql
CREATE INDEX idx_video_id
ON video_meta(video_id);
```

---

### 2. playlist_id

用于：

* 收藏夹查询
* 增量同步

```sql
CREATE INDEX idx_playlist_id
ON video_meta(playlist_id);
```

---

### 3. is_deleted

用于：

* 过滤软删除

```sql
CREATE INDEX idx_video_deleted
ON video_meta(is_deleted);
```

---

### 4. publish_time

用于：

* 排序
* 随机推荐

```sql
CREATE INDEX idx_publish_time
ON video_meta(publish_time);
```

---

# 四、同步状态机

推荐：

```txt
idle
  ↓
checking
  ↓
syncing
  ↓
success
  ↓
idle
```

异常：

```txt
syncing
  ↓
failed

syncing
  ↓
cancelled
```

---

# 五、完整同步流程

这是核心。

---

# Step 1：获取远端收藏夹信息

```ts
remotePlaylist = await fetchPlaylistMeta()
```

获取：

```ts
{
  videoCount,
  revision,
}
```

---

# Step 2：读取本地 playlist_meta

```ts
localPlaylist = await db.get(...)
```

---

# Step 3：判断是否需要同步

```ts
if (
  local.remoteRevision !== remote.revision ||
  local.localSyncedCount < remote.videoCount ||
  local.needResync
) {
   needSync = true
}
```

---

# Step 4：创建同步任务

```ts
sync_job.status = "running"
```

---

# Step 5：从 cursor 开始分页同步

核心：

```txt
远端分页
   ↓
写入数据库
   ↓
更新cursor
   ↓
继续下一页
```

---

# 六、同步伪代码（核心）

---

# 核心同步函数

```ts
async function syncPlaylist(playlistId: string) {

  const playlist = await getPlaylistMeta(playlistId)

  const remoteMeta = await fetchRemotePlaylistMeta(playlistId)

  const job = await createSyncJob()

  let cursor = playlist.syncCursor

  while (true) {

    const page = await fetchPlaylistPage({
      playlistId,
      cursor,
    })

    if (!page.items.length) {
      break
    }

    await database.write(async () => {

      for (const item of page.items) {

        await upsertVideo(item)
      }

      // 更新游标
      await playlist.update(record => {
        record.syncCursor = page.nextCursor
        record.localSyncedCount += page.items.length
      })
    })

    cursor = page.nextCursor

    if (!cursor) {
      break
    }
  }

  await finishSyncJob(job)

  await markPlaylistSuccess(playlistId)
}
```

---

# 七、upsertVideo 实现

WatermelonDB 没有真正 upsert。

你需要自己实现。

---

```ts
async function upsertVideo(video) {

  const collection = database.collections.get('video_meta')

  const existing = await collection
    .query(
      Q.where('video_id', video.id)
    )
    .fetch()

  if (existing.length > 0) {

    await existing[0].update(v => {
      v.title = video.title
      v.cover = video.cover
      v.updatedAt = Date.now()
    })

  } else {

    await collection.create(v => {
      v.videoId = video.id
      v.playlistId = video.playlistId
      v.title = video.title
      v.cover = video.cover
      v.syncedAt = Date.now()
    })
  }
}
```

---

# 八、断点续传机制

这是关键。

同步过程中：

```txt
每完成一页
立即更新 sync_cursor
```

这样：

* APP 崩溃
* 手机断电
* 强退

都能恢复。

恢复时：

```ts
cursor = playlist.syncCursor
```

继续同步。

---

# 九、删除同步（非常重要）

推荐：

## 不直接删除

而是：

```ts
is_deleted = true
```

原因：

* 避免误删
* 可以恢复
* 减少 SQLite delete 开销

---

# 删除流程

同步完成后：

```txt
远端视频集合
VS
本地视频集合
```

差集：

```ts
is_deleted = true
```

---

# 十、随机播放优化（重点）

你现在最需要的是：

## 不要 ORDER BY RANDOM()

SQLite 会炸。

---

# 正确做法

提前生成：

```ts
random_weight
```

查询：

```sql
WHERE random_weight > x
LIMIT 1
```

没有结果再回绕。

---

# 十一、搜索优化

WatermelonDB 本身全文搜索一般。

建议：

## 小规模：

LIKE 即可。

---

## 大规模（推荐）

建立：

```txt
video_search_index
```

预处理：

* 小写
* 去空格
* 拼音
* 标签

否则几万视频以后：

LIKE 会越来越慢。

---

# 十二、最重要的最终优化（你后面一定会遇到）

---

# 不要一次性同步整个收藏夹

一定：

```txt
分页 + 分批 write
```

否则：

* JS bridge 卡死
* SQLite 锁表
* RN 掉帧
* Android ANR

---

# 推荐分页大小

```txt
20~50
```

别超过：

```txt
100
```

---

# 十三、最终推荐架构

最终：

```txt
playlist_meta
    ↓
sync_job
    ↓
video_meta
```

同步：

```txt
分页拉取
  ↓
批量写入
  ↓
更新cursor
  ↓
断点恢复
```

查询：

```txt
video_meta
  ↓
随机播放
  ↓
搜索
  ↓
缓存
```

这是目前最适合你这种：

* B站收藏夹音乐播放器
* 本地索引
* 大规模随机播放
* 离线缓存

的架构。
