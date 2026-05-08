/** 音质选项 */
export type Quality = 'low' | 'medium' | 'high' | 'dolby' | 'hires';

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
  /** 原始返回的记录数（在过滤失效视频前） */
  rawCount: number;
}
