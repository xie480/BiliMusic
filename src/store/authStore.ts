import { create } from 'zustand';
import { cookieService } from '../services';
import { biliApi } from '../services/biliApi';

type UserInfo = {
  uid: string;
  name: string;
  avatar: string;
};

/** B 站大会员等级 */
export type VipStatus = {
  /** 会员类型: 0=无, 1=月度, 2=年度 */
  type: number;
  /** 会员状态: 0=无, 1=有效 */
  status: number;
  /** 大会员到期时间（时间戳，秒） */
  dueDate?: number;
};

/** Auth store to manage login state and coordinate login flow */
type AuthState = {
  /** 是否已登录 */
  loggedIn: boolean;
  /** 当前用户 UID */
  userId: string | null;
  /** 当前用户信息 */
  userInfo: UserInfo | null;
  /** 大会员状态（null 表示未登录或尚未获取） */
  vipStatus: VipStatus | null;
  /** 是否为有效大会员（快捷访问） */
  isVip: boolean;
  /** 认证状态是否已初始化完成 */
  authReady: boolean;
  /** 登录成功后调用，设置状态并可传入 UID */
  login: (uid?: string) => Promise<void>;
  /** 登出，清除本地 Cookie 并重置状态 */
  logout: () => Promise<void>;
  /** 用于在登录完成后继续挂起的请求 */
  setLoginResolver: (resolver: () => void) => void;
  /** 保存当前的 resolver，登录完成后调用 */
  loginResolver: (() => void) | null;
  /** 手动设置用户信息 */
  setUserInfo: (info: UserInfo) => void;
  /** 初始化认证状态，应用启动时调用 */
  initAuth: () => Promise<void>;
  /** 设置认证就绪状态 */
  setAuthReady: (ready: boolean) => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  loggedIn: false,
  userId: null,
  userInfo: null,
  vipStatus: null,
  isVip: false,
  authReady: false,
  initAuth: async () => {
    const cookie = await cookieService.get();
    if (cookie) {
      try {
        const info = await biliApi.getUserInfo();
        const isVip = info.vipStatus.status === 1 && info.vipStatus.type > 0;
        set({
          loggedIn: true,
          userId: info.uid,
          userInfo: { uid: info.uid, name: info.name, avatar: info.avatar },
          vipStatus: info.vipStatus,
          isVip,
        });
      } catch (e) {
        console.error('initAuth failed', e);
        set({ loggedIn: false, userId: null, userInfo: null, vipStatus: null, isVip: false });
      }
    } else {
      set({ loggedIn: false, userId: null, userInfo: null, vipStatus: null, isVip: false });
    }
    set({ authReady: true });
  },
  setAuthReady: (ready) => set({ authReady: ready }),
  login: async (uid) => {
    set({ loggedIn: true, userId: uid ?? null });
    try {
      const info = await biliApi.getUserInfo();
      const isVip = info.vipStatus.status === 1 && info.vipStatus.type > 0;
      set({
        userInfo: { uid: info.uid, name: info.name, avatar: info.avatar },
        userId: info.uid,
        vipStatus: info.vipStatus,
        isVip,
      });
    } catch (e) {
      console.error('login fetch user info failed', e);
    }
    const resolver = get().loginResolver;
    if (resolver) {
      resolver();
      set({ loginResolver: null });
    }
  },
  logout: async () => {
    await cookieService.clear();
    set({ loggedIn: false, userId: null, userInfo: null, vipStatus: null, isVip: false });
  },
  setLoginResolver: (resolver) => {
    set({ loginResolver: resolver });
  },
  loginResolver: null,
  setUserInfo: (info) => set({ userInfo: info }),
}));
