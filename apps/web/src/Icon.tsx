import type React from 'react';
import { BrandGlyph } from './Brand';

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  if (name === 'spark') return <BrandGlyph size={size} />;
  const paths: Record<string, React.ReactNode> = {
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M9 4v16" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />,
    collapse: <path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    edit: <path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15Z" />,
    pin: <path d="m15 3 6 6-5 1-3 5-4-4 5-3ZM10 14l-7 7" />,
    eye: (
      <>
        <path d="M2 12C5 3 19 3 22 12C19 21 5 21 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="13" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    ),
    archive: (
      <>
        <rect x="3" y="3" width="18" height="5" rx="1" />
        <path d="M5 8v13h14V8M9 12h6" />
      </>
    ),
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    send: (
      <>
        <path d="m4 12 16-8-5 16-3-7-8-1Zm8 1 8-9" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pause: <path d="M8 5v14M16 5v14" />,
    play: <path d="m7 4 13 8-13 8Z" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    file: (
      <>
        <path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6" />
      </>
    ),
    tree: (
      <>
        <rect x="9" y="2" width="6" height="5" rx="1" />
        <rect x="2" y="17" width="6" height="5" rx="1" />
        <rect x="16" y="17" width="6" height="5" rx="1" />
        <path d="M12 7v5M5 17v-5h14v5" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-8" />
      </>
    ),
    chat: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 1-6a8 8 0 0 1-1-5 9 9 0 0 1 19 0Z" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4" />
      </>
    ),
    history: (
      <>
        <path d="M3 4v5h5M3 9a9 9 0 1 1 1 9m8-12v6l4 2" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v11H3Z" />,
    refresh: (
      <>
        <path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
}
