import React, { useRef } from 'react';
import { Modal, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import LoggerService from '../services/LoggerService';
import { useAuthStore } from '../store/authStore';
import { useUIStore } from '../store/uiStore';
import { cookieService } from '../services';

/**
 * 全局登录弹窗，使用 B 站官方登录页面进行扫码或密码登录。
 * 登录成功后会读取 .bilibili.com 域的所有 Cookie，提取 SESSDATA、bili_jct、DedeUserID 等关键字段。
 * 完整的 Cookie 字符串会通过 cookieService.save 保存至安全存储，
 * 并调用 authStore.login(uid) 标记已登录状态。
 */
export const LoginModal = () => {
  const webViewRef = useRef<WebView>(null);
  const login = useAuthStore((s) => s.login);
  const loginModalVisible = useUIStore((s) => s.loginModalVisible);
  const setLoginModalVisible = useUIStore((s) => s.setLoginModalVisible);

  const handleNavigationStateChange = async (navState: any) => {
    const url: string = navState.url;
    // 登录成功后 B 站会跳转到主站或移动站页面
    if (url.startsWith('https://www.bilibili.com/') || url.startsWith('https://m.bilibili.com/')) {
      // 停止继续加载
      webViewRef.current?.stopLoading();
      // 读取所有 Cookie（.bilibili.com 域）
      // 使用当前跳转完成的 URL 获取对应域下的完整 Cookie
      const rawCookies = await CookieManager.get(url);
      const cookieStr = Object.entries(rawCookies)
        .map(([k, v]: any) => `${k}=${v.value}`)
        .join('; ');
      // 保存完整 Cookie 字符串到安全存储，并输出调试日志
      if (__DEV__) {
        const sessMatch = cookieStr.match(/SESSDATA=([^;]+)/);
        const sessLen = sessMatch ? sessMatch[1].length : 0;
        LoggerService.info('LoginModal', 'handleNavigationStateChange', '获取到 Cookie 字段:', Object.keys(rawCookies).join(', '));
        LoggerService.info('LoginModal', 'handleNavigationStateChange', 'Cookie 总长度:', cookieStr.length, ', SESSDATA 长度:', sessLen);
        if (sessLen > 0 && sessLen < 50) {
          LoggerService.warn('LoginModal', 'handleNavigationStateChange', 'SESSDATA 异常短小！完整 Cookie:', cookieStr);
        }
      }
      // 保存 Cookie 到安全存储
      await cookieService.set(cookieStr);
      // 提取 UID（DedeUserID）
      const uidMatch = cookieStr.match(/DedeUserID=([0-9]+)/);
      const uid = uidMatch ? uidMatch[1] : undefined;
      // 标记登录状态
      await login(uid);
      // 关闭弹窗
      setLoginModalVisible(false);
    }
  };

  return (
    <Modal
      visible={loginModalVisible}
      animationType="slide"
      onRequestClose={() => setLoginModalVisible(false)}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://passport.bilibili.com/login' }}
          onNavigationStateChange={handleNavigationStateChange}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
        />
      </SafeAreaView>
    </Modal>
  );
};
