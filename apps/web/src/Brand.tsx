/**
 * 渲染品牌图标、标记及工作区和交付空状态插图。
 * 集中维护SVG图形及空状态构图，通过尺寸和样式参数复用；不承担工作区或交付数据读取。
 * EN: Renders brand icons, the brand mark, and workspace or delivery empty-state illustrations. Centralizes reusable SVG marks and empty-state artwork through size/style parameters, without reading workspace or delivery data.
 */
import appIcon from '../../../assets/brand/app-icon.svg';
import mark from '../../../assets/brand/mark.svg';
import workspace from '../../../assets/brand/workspace-empty.svg';
import delivery from '../../../assets/brand/delivery-empty.svg';

/**
 * 装饰性品牌图不重复提供无障碍名称；调用方可覆盖样式类。
 * EN: Decorative brand artwork does not repeat an accessible name; callers may override its CSS class.
 */
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

/**
 * 以 CSS mask 复用单色品牌路径，颜色由调用位置继承，size 同时控制宽高。
 * EN: Reuse the monochrome brand path as a CSS mask. Color is inherited from the surrounding context, and size sets both dimensions.
 */
export function BrandGlyph({ size = 18 }: { size?: number }) {
  return (
    <span
      className="brand-glyph"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: `url("${mark}")` }}
    />
  );
}

/**
 * 根据工作区或交付场景选择对应空状态插图。
 * EN: Select the empty-state illustration for the workspace or delivery context.
 */
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
