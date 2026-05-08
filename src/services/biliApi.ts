import { biliGet } from '../core/http';
import { encWbi, getWbiKeys } from '../core/wbi';
import type {
  BiliFolder,
  BiliFavoriteVideoMedia,
  BiliVideoInfo,
  BiliPlayUrlData,
} from '../types/bili';

interface FolderListResp {
  count: number;
  list: BiliFolder[];
}

interface FavoriteListResp {
  info: { id: number; title: string; media_count: number };
  medias: BiliFavoriteVideoMedia[];
  has_more: boolean;
}

export const biliApi = {
  /** 获取用户全部收藏夹（后台静默请求，鉴权失败时不唤起 Webview 登录弹窗） */
  getFavoriteFolders(upMid: string, signal?: AbortSignal) {
    if (!upMid) {
      return Promise.reject(new Error('upMid 不能为空'));
    }
    return biliGet<FolderListResp>('/x/v3/fav/folder/created/list-all', {
      params: { up_mid: upMid },
      signal,
      silent: true,
    });
  },

  /** 获取收藏夹内视频（分页，后台静默请求） */
  getFavoriteVideos(mediaId: string | number, pn = 1, ps = 20, signal?: AbortSignal) {
    if (!mediaId) {
      return Promise.reject(new Error('mediaId 不能为空'));
    }
    // B 站收藏夹资源列表需要 WBI 签名 (wts + w_rid)
    // 使用最新的 WBI 密钥对请求参数进行签名后拼接到 URL，避免 axios 再次编码 params
    return (async () => {
      const { imgKey, subKey } = await getWbiKeys();
      const signedQuery = encWbi(
        { media_id: mediaId, pn, ps, platform: 'web', order: 'mtime' },
        imgKey,
        subKey,
      );
      // 将签名后的查询字符串直接拼接到路径上
      return biliGet<FavoriteListResp>(`/x/v3/fav/resource/list?${signedQuery}`, {
        signal,
        silent: true,
      });
    })();
  },

  /** 获取视频元信息（含 cid） */
  getVideoInfo(bvid: string) {
    if (!bvid) {
      return Promise.reject(new Error('bvid 不能为空'));
    }
    return biliGet<BiliVideoInfo>('/x/web-interface/view', {
      params: { bvid },
    });
  },
  
  /** 获取播放地址（DASH，含独立音频流，需 WBI 签名） */
  async getPlayUrl(bvid: string, cid: number) {
    if (!bvid || cid == null) {
      throw new Error('bvid 和 cid 不能为空');
    }
    const { imgKey, subKey } = await getWbiKeys();
    const query = encWbi(
      { bvid, cid, fnval: 16, fnver: 0, fourk: 1 },
      imgKey,
      subKey
    );
    return biliGet<BiliPlayUrlData>(`/x/player/wbi/playurl?${query}`);
  },

  /** 获取登录用户信息（包含 UID、用户名、头像、大会员状态） */
  async getUserInfo() {
    const data = await biliGet<any>('/x/web-interface/nav');
    if (!data) {
      throw new Error('获取用户信息失败');
    }
    const uid = data?.mid ? String(data.mid) : '';
    const name = data?.uname ?? '';
    const avatar = data?.face ?? '';
    const vipStatus = {
      type: data?.vip_type ?? 0,
      status: data?.vip_status ?? 0,
      dueDate: data?.vip_due_date ? Math.floor(data.vip_due_date / 1000) : undefined,
    };
    return { uid, name, avatar, vipStatus };
  },
};
