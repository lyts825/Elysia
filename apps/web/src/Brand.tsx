/* 渲染品牌图标、标记及工作区和交付空状态插图。 */
import appIcon from '../../../assets/brand/app-icon.svg';
import mark from '../../../assets/brand/mark.svg';
import workspace from '../../../assets/brand/workspace-empty.svg';
import delivery from '../../../assets/brand/delivery-empty.svg';

/** 装饰性品牌图不重复提供无障碍名称；调用方可覆盖样式类。 */
export function BrandIcon({ className = 'brand-mark' }: { className?: string }) {
  return (
    <img
      className={className}
      src={appIcon}
      width={36}
      height={36}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function BrandGlyph({ size = 18 }: { size?: number }) {
  return (
    <span
      className="brand-glyph"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: `url("${mark}")` }}
    />
  );
}

/** 根据工作区或交付场景选择对应空状态插图。 */
export function EmptyArtwork({ kind }: { kind: 'workspace' | 'delivery' }) {
  return (
    <img
      className="empty-art"
      src={kind === 'workspace' ? workspace : delivery}
      width={200}
      height={148}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
