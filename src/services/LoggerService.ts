/**
 * LoggerService - 统一日志服务
 *
 * 功能：
 * 1. 拦截全局 console 方法，统一格式化并持久化日志
 * 2. 自动获取调用栈中的文件名和方法名
 * 3. warn/error 级别触发顶部通知回调
 * 4. 支持日志文件导出
 */

import RNFS from 'react-native-fs';
import { Platform, Share, ToastAndroid, Alert } from 'react-native';

// 日志级别枚举
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

// Toast 通知回调类型
type ToastCallback = (level: LogLevel, message: string) => void;

class LoggerService {
  private static isInitialized = false;
  private static logDir = `${RNFS.DocumentDirectoryPath}/logs`;
  private static currentLogFile = '';
  private static toastCallback: ToastCallback | null = null;
  private static maxLogEntries = 1000; // 内存中保留的最大日志条数
  private static logBuffer: string[] = [];

  // 保存原生 console 引用，避免死循环且保留开发环境输出
  private static originalConsole = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  /**
   * 初始化日志服务
   * @param toastCallback 可选的通知回调，用于触发顶部 Toast
   */
  static async init(toastCallback?: ToastCallback) {
    if (this.isInitialized) return;

    this.toastCallback = toastCallback || null;

    try {
      // 确保日志目录存在
      const exists = await RNFS.exists(this.logDir);
      if (!exists) {
        await RNFS.mkdir(this.logDir);
      }

      // 创建当前日期的日志文件
      const dateStr = new Date().toISOString().slice(0, 10);
      this.currentLogFile = `${this.logDir}/app-${dateStr}.log`;

      // 限制日志文件数量，只保留最近 7 天
      await this.cleanOldLogs(7);

      // 拦截全局 console
      this.interceptConsole();

      this.isInitialized = true;
      this.info('LoggerService', 'init', '日志服务初始化完成');
    } catch (error) {
      // 如果文件系统初始化失败，仍然拦截 console 但跳过文件写入
      console.warn('[LoggerService] 文件日志初始化失败，将仅使用内存日志:', error);
      this.interceptConsole();
      this.isInitialized = true;
    }
  }

  /**
   * 清理旧日志文件
   */
  private static async cleanOldLogs(maxDays: number) {
    try {
      const files = await RNFS.readDir(this.logDir);
      const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
      for (const file of files) {
        if (file.name.endsWith('.log') && file.mtime.getTime() < cutoff) {
          await RNFS.unlink(file.path);
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  /**
   * 解析调用栈，获取文件名和方法名
   */
  private static getCallerInfo(depth = 3): { file: string; method: string } {
    try {
      const err = new Error();
      const stackLines = err.stack?.split('\n') || [];
      // 在拦截后的 console 中，栈深度需要 +1
      const callerLine = stackLines[depth] || '';

      // 适配不同 JS 引擎的堆栈格式
      // Chrome/V8: at method (file:line:col)
      // Hermes: at method (file:line:col), at file:line:col
      const match =
        callerLine.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
        callerLine.match(/at\s+(.+?)\s+\((.*?)\)/) ||
        callerLine.match(/at\s+(.+?:\d+:\d+)/) ||
        callerLine.match(/at\s+(\S+)/);

      if (match) {
        const rawMethod = match[1] || '';
        const rawFile = match[2] || match[1] || '';

        // 清理文件名
        let file = rawFile;
        // 提取文件名部分
        if (file.includes('/')) {
          file = file.split('/').pop() || 'unknown';
        }
        // 去掉 ? 查询参数 (metro bundler)
        file = file.split('?')[0];
        // 去掉文件扩展名后的行号信息
        file = file.replace(/:\d+:\d+$/, '');

        // 清理方法名
        let method = rawMethod;
        if (method.includes('.')) {
          method = method.split('.').pop() || method;
        }
        // 过滤匿名和内部调用
        if (method === 'Object.<anonymous>' || method === '<unknown>') {
          method = 'anonymous';
        }

        return { file, method };
      }
    } catch {
      // 解析失败返回默认值
    }
    return { file: 'unknown', method: 'unknown' };
  }

  /**
   * 格式化日志行
   */
  private static formatLog(
    level: LogLevel,
    module: string,
    methodName: string,
    args: any[],
  ): string {
    const timestamp = new Date().toISOString();
    const message = args
      .map((arg) =>
        arg instanceof Error
          ? arg.stack || arg.message
          : typeof arg === 'object'
            ? JSON.stringify(arg, null, 0)
            : String(arg),
      )
      .join(' ');

    // 格式: [时间戳] [级别] [模块::方法] 内容
    return `[${timestamp}] [${level}] [${module}::${methodName}] ${message}`;
  }

  /**
   * 将日志写入文件和缓冲区
   */
  private static async writeLog(
    level: LogLevel,
    module: string,
    methodName: string,
    args: any[],
  ) {
    const formatted = this.formatLog(level, module, methodName, args);

    // 写入内存缓冲区
    this.logBuffer.push(formatted);
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.splice(0, this.logBuffer.length - this.maxLogEntries);
    }

    // 异步写入文件（不阻塞调用）
    if (this.currentLogFile) {
      try {
        await RNFS.appendFile(this.currentLogFile, formatted + '\n', 'utf8');
      } catch {
        // 文件写入失败不抛出异常
      }
    }

    // warn/error 级别触发 Toast 通知
    if (
      this.toastCallback &&
      (level === LogLevel.WARN || level === LogLevel.ERROR)
    ) {
      // 提取精简消息：取前 150 个字符
      const shortMsg = args
        .map((a) =>
          a instanceof Error
            ? a.message
            : typeof a === 'object'
              ? JSON.stringify(a)
              : String(a),
        )
        .join(' ')
        .substring(0, 150);
      this.toastCallback(level, shortMsg);
    }
  }

  // ========== 拦截全局 console ==========

  private static interceptConsole() {
    const self = this;

    console.debug = function (...args: any[]) {
      const { file, method } = self.getCallerInfo(4);
      self.writeLog(LogLevel.DEBUG, file, method, args);
      self.originalConsole.debug(...args);
    };

    console.info = function (...args: any[]) {
      const { file, method } = self.getCallerInfo(4);
      self.writeLog(LogLevel.INFO, file, method, args);
      self.originalConsole.info(...args);
    };

    console.log = function (...args: any[]) {
      const { file, method } = self.getCallerInfo(4);
      self.writeLog(LogLevel.INFO, file, method, args);
      self.originalConsole.log(...args);
    };

    console.warn = function (...args: any[]) {
      const { file, method } = self.getCallerInfo(4);
      self.writeLog(LogLevel.WARN, file, method, args);
      self.originalConsole.warn(...args);
    };

    console.error = function (...args: any[]) {
      const { file, method } = self.getCallerInfo(4);
      self.writeLog(LogLevel.ERROR, file, method, args);
      self.originalConsole.error(...args);
    };
  }

  // ========== 静态便捷方法 ==========

  static debug(module: string, method: string, ...args: any[]) {
    const { file, method: autoMethod } = this.getCallerInfo(3);
    this.writeLog(LogLevel.DEBUG, module || file, method || autoMethod, args);
  }

  static info(module: string, method: string, ...args: any[]) {
    const { file, method: autoMethod } = this.getCallerInfo(3);
    this.writeLog(LogLevel.INFO, module || file, method || autoMethod, args);
  }

  static warn(module: string, method: string, ...args: any[]) {
    const { file, method: autoMethod } = this.getCallerInfo(3);
    this.writeLog(LogLevel.WARN, module || file, method || autoMethod, args);
  }

  static error(module: string, method: string, ...args: any[]) {
    const { file, method: autoMethod } = this.getCallerInfo(3);
    this.writeLog(LogLevel.ERROR, module || file, method || autoMethod, args);
  }

  // ========== 日志导出 ==========

  /**
   * 获取所有日志文件列表
   */
  static async getLogFilePaths(): Promise<string[]> {
    try {
      const exists = await RNFS.exists(this.logDir);
      if (!exists) return [];

      const files = await RNFS.readDir(this.logDir);
      return files
        .filter((f) => f.name.endsWith('.log'))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .map((f) => f.path);
    } catch {
      return [];
    }
  }

  /**
   * 导出日志 - 调用系统分享
   */
  static async exportLogs(): Promise<boolean> {
    try {
      const logFiles = await this.getLogFilePaths();
      if (logFiles.length === 0) {
        if (Platform.OS === 'android') {
          ToastAndroid.show('暂无日志文件可导出', ToastAndroid.SHORT);
        } else {
          Alert.alert('提示', '暂无日志文件可导出');
        }
        return false;
      }

      // 合并所有日志文件为一个临时导出文件
      const exportPath = `${RNFS.CachesDirectoryPath}/BiliMusic_logs_export.txt`;
      let combinedContent = '';

      for (const filePath of logFiles) {
        try {
          const content = await RNFS.readFile(filePath, 'utf8');
          combinedContent += `=== ${filePath.split('/').pop()} ===\n${content}\n\n`;
        } catch {
          // 跳过无法读取的文件
        }
      }

      if (Platform.OS === 'android') {
        const downloadPath = `${RNFS.DownloadDirectoryPath}/BiliMusic_logs_export_${Date.now()}.txt`;
        await RNFS.writeFile(downloadPath, combinedContent, 'utf8');
        ToastAndroid.show(`日志已导出至: ${downloadPath}`, ToastAndroid.LONG);
      } else {
        // 写入临时导出文件
        await RNFS.writeFile(exportPath, combinedContent, 'utf8');

        // 使用系统分享
        await Share.share({
          title: 'BiliMusic 运行日志',
          message: '请查收 BiliMusic 应用运行日志文件',
          url: exportPath,
        });
      }

      this.info('LoggerService', 'exportLogs', '日志导出成功');
      return true;
    } catch (error) {
      console.error('[LoggerService] 导出日志失败:', error);
      return false;
    }
  }

  /**
   * 删除所有日志文件
   * @returns 是否成功删除
   */
  static async clearLogs(): Promise<boolean> {
    try {
      const logFiles = await this.getLogFilePaths();
      if (logFiles.length === 0) {
        if (Platform.OS === 'android') {
          ToastAndroid.show('暂无日志文件', ToastAndroid.SHORT);
        }
        return false;
      }

      for (const filePath of logFiles) {
        try {
          await RNFS.unlink(filePath);
        } catch (e) {
          console.warn('[LoggerService] 删除日志文件失败:', filePath, e);
        }
      }

      // 清空内存缓冲区
      this.logBuffer = [];

      this.info('LoggerService', 'clearLogs', `已删除 ${logFiles.length} 个日志文件`);
      return true;
    } catch (error) {
      console.error('[LoggerService] 清空日志失败:', error);
      return false;
    }
  }

  /**
   * 获取内存中的最近日志
   */
  static getRecentLogs(count = 50): string[] {
    return this.logBuffer.slice(-count);
  }

  /**
   * 读取最新的日志文件内容
   */
  static async readLatestLogFile(): Promise<string> {
    try {
      const logFiles = await this.getLogFilePaths();
      if (logFiles.length === 0) return '';
      return await RNFS.readFile(logFiles[0], 'utf8');
    } catch {
      return '';
    }
  }
}

export default LoggerService;
