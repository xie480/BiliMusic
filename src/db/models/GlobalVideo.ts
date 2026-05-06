import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';
import type { FavoriteVideo } from '../../types/domain';

export class GlobalVideo extends Model {
  static table = 'global_videos';

  @field('bvid') bvid!: string;
  @field('title') title!: string;
  @field('cover') cover!: string;
  @field('duration') duration!: number;
  @field('page') page!: number;
  @field('pubtime') pubtime!: number;
  @field('upper_mid') upperMid!: number;
  @field('upper_name') upperName!: string;
  @field('attr') attr!: number;
  @field('folder_ids') folderIds!: string;
  @field('parts') parts!: string;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;

  /** 获取 folderIds 数组（从 JSON 字符串解析） */
  getFolderIdsArray(): number[] {
    try {
      return this.folderIds ? JSON.parse(this.folderIds) : [];
    } catch {
      return [];
    }
  }

  /** 转换为业务层 FavoriteVideo 对象 */
  toFavoriteVideo(): FavoriteVideo {
    return {
      bvid: this.bvid,
      title: this.title,
      cover: this.cover,
      duration: this.duration,
      page: this.page,
      pubtime: this.pubtime,
      upper: { mid: this.upperMid, name: this.upperName },
      attr: this.attr,
      folderIds: this.getFolderIdsArray(),
      parts: this.parts ? JSON.parse(this.parts) : undefined,
    };
  }
}
