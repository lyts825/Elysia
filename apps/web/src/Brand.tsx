import appIcon from '../../../assets/brand/app-icon.svg';
import mark from '../../../assets/brand/mark.svg';
import workspace from '../../../assets/brand/workspace-empty.svg';
import delivery from '../../../assets/brand/delivery-empty.svg';
import garden from '../../../assets/brand/garden-light.svg';

export function GardenAccent() {
  return (
    <img
      className="garden-accent"
      src={garden}
      width={720}
      height={260}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

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
