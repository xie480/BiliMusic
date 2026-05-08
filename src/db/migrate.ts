import LoggerService from '../services/LoggerService';
import { clearAllData } from './operations';

/**
 * 数据库迁移脚本
 * 由于底层数据结构发生了根本性变化（从 JSON 数组关联变为扁平化的一对多关系），
 * 且旧表已被移除，最安全的策略是清除旧缓存，触发全量重新同步。
 */
export async function migrateToV2(): Promise<void> {
  try {
    LoggerService.info('migrate', 'migrateToV2', '开始执行 V2 数据库迁移/清理...');
    // 清除所有新表数据，确保干净的状态
    await clearAllData();
    LoggerService.info('migrate', 'migrateToV2', 'V2 数据库清理完成，等待重新同步。');
  } catch (error) {
    LoggerService.error('migrate', 'migrateToV2', 'V2 数据库迁移失败:', error);
  }
}
