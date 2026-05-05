import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { cookieService } from '../services';
import { adaptiveBucket } from './adaptiveRateLimit';
import {
  AuthRequiredError, BiliApiError, normalizeError,
  ResourceUnavailableError, RateLimitError,
} from './errors';
import type { BiliResponse } from '../types/bili';
import { useAuthStore } from '../store/authStore';
import { useUIStore } from '../store/uiStore';

/** 创建带默认头的 axios 实例 */
function createInstance(): AxiosInstance {
  const ins = axios.create({
    baseURL: config.biliBaseURL,
    timeout: config.httpTimeout,
    headers: {
      'User-Agent': config.userAgent,
      Referer: config.referer,
    },
  });

  // 请求拦截：限流 + 自动注入 Cookie（使用加密存储）
  ins.interceptors.request.use(async (cfg) => {
    await adaptiveBucket.acquire();
    const cookie = await cookieService.get();
    if (cookie) {
      if (typeof cfg.headers.set === 'function') {
        cfg.headers.set('Cookie', cookie);
      } else {
        cfg.headers.Cookie = cookie;
      }
    }
    return cfg;
  });

  // 响应拦截：归一化错误 + 状态上报
  ins.interceptors.response.use(
    (res) => {
      adaptiveBucket.reportSuccess();
      return res;
    },
    (err) => {
      const isRateLimit = err?.response?.status === 412 || err?.response?.status === 429;
      adaptiveBucket.reportError(isRateLimit);
      return Promise.reject(normalizeError(err));
    }
  );
  return ins;
}

export const http = createInstance();

/** 业务码错误映射 */
function mapBusinessError(code: number, message: string): never {
  if (code === -101 || code === -400) throw new AuthRequiredError(message);
  if (code === 62002 || code === 62004) throw new ResourceUnavailableError(message);
  throw new BiliApiError(code, message);
}

/**
 * 请求 B 站 API 并自动校验 code，附带重试
 */
export async function biliGet<T>(
  url: string,
  options: AxiosRequestConfig = {},
  retries = config.retry.maxAttempts
): Promise<T> {
  let lastError: any;
  const absoluteTimeout = 60000; // 60 秒的绝对超时（与 config.httpTimeout 对齐）
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 为每次尝试创建独立的 AbortController，以实现绝对超时
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), absoluteTimeout);
    // 合并用户传入的 signal（若有）和内部的 abortController.signal
    const combinedSignal = options.signal ?? abortController.signal;
    // 若用户提供了 signal，我们在其 abort 时同步 abort 内部的 controller
    const onAbort = () => abortController.abort();
    if (options.signal) {
      // AbortSignal 在较新的 TS 类型中 addEventListener 可能标记为可选，使用 onabort 作为兼容方案
      if (typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', onAbort);
      } else {
        // 回退到 onabort 属性赋值（已废弃但兼容旧环境）
        (options.signal as any).onabort = onAbort;
      }
    }
    const requestOptions: AxiosRequestConfig = { ...options, signal: combinedSignal };
    try {
      const res = await http.get<BiliResponse<T>>(url, requestOptions);
      clearTimeout(timeoutId);
      const { code, data, message } = res.data;
      if (code !== 0) mapBusinessError(code, message);
      return data;
    } catch (err: any) {
      clearTimeout(timeoutId);
      lastError = err;
      // 处理鉴权错误，其他业务错误直接抛出
      if (err instanceof AuthRequiredError) {
        // 显示登录弹窗
        useUIStore.getState().setLoginModalVisible(true);
        // 返回一个 Promise，等待登录完成后重试一次
        return new Promise<T>((resolve, reject) => {
          useAuthStore.getState().setLoginResolver(async () => {
            try {
              const retryRes = await http.get<BiliResponse<T>>(url, requestOptions);
              const { code, data, message } = retryRes.data;
              if (code !== 0) mapBusinessError(code, message);
              resolve(data);
            } catch (e) {
              reject(e);
            }
          });
        });
      }
      if (
        err instanceof BiliApiError ||
        err instanceof ResourceUnavailableError
      ) {
        throw err;
      }
      if (err instanceof RateLimitError) {
        if (attempt < retries) {
          const delay = Math.min(config.retry.delayMs * Math.pow(2, attempt), 30000);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
      if (attempt < retries) {
        let delay = config.retry.delayMs * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      if (options.signal) {
        if (typeof options.signal.removeEventListener === 'function') {
          options.signal.removeEventListener('abort', onAbort);
        } else {
          if ((options.signal as any).onabort === onAbort) {
            (options.signal as any).onabort = null;
          }
        }
      }
    }
  }
  throw lastError;
}
