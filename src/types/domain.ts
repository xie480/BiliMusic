export type Quality = 'low' | 'medium' | 'high';

/** 收藏夹（精简后）*/
export interface FavoriteFolder {
  id: number;
  fid: number;
  mid: number;
  title: string;
  mediaCount: number;
}

/** 视频分段（P）信息 */
export interface VideoPart {
  cid: number;
  page: number;
  title: string;
  duration: number;
}

/** 收藏夹中的视频条目（精简后）*/
export interface FavoriteVideo {
  bvid: string;
  title: string;
  cover: string;
  duration: number;
  page: number;
  pubtime: number;
  upper: { mid: number; name: string };
  attr: number;
  folderIds?: number[];
  /** 分P 列表，仅在获取到视频详情后填充 */
  parts?: VideoPart[];
}

/** 音频流信息 */
export interface AudioInfo {
  bvid: string;
  cid: number;
  title: string;
  cover: string;
  author: string;
  duration: number;
  audio: {
    id: number;
    bitrate: number;        // kbps
    mimeType: string;
    baseUrl: string;        // 真实 CDN 地址
    backupUrl: string[];    // 备用 CDN
  };
  /** 视频分段信息，仅在获取到详情后填充 */
  parts?: VideoPart[];
}

/** 分页结果 */
export interface PageResult<T> {
  list: T[];
  hasMore: boolean;
}

/** 收藏夹同步元数据 - 用于增量同步的状态追踪 */
export interface FolderSyncMeta {
  folderId: number;
  lastSyncTime: number;
  latestBvid: string | null;
  mediaCount: number;
  /** 标记该文件夹需要下次全量校准（检测到删除或同步中断时设置） */
  needsFullSync?: boolean;
  /** 最近一次同步完成的页码，用于断点续传 */
  lastSyncedPage?: number;
}
