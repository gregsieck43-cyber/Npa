import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "calendar"
  | "folder"
  | "check"
  | "book"
  | "automation"
  | "settings"
  | "search"
  | "sun"
  | "moon"
  | "menu"
  | "close"
  | "plus"
  | "arrow"
  | "play"
  | "pause"
  | "spark"
  | "terminal"
  | "code"
  | "database"
  | "canvas"
  | "git"
  | "globe"
  | "research"
  | "memory"
  | "shield"
  | "activity"
  | "command"
  | "chevron"
  | "more"
  | "clock"
  | "bolt"
  | "lock"
  | "refresh"
  | "external"
  | "dot"
  | "checkCircle"
  | "alert"
  | "loader";

const paths: Record<IconName, ReactNode> = {
  calendar: <path d="M7 3v3m10-3v3M4.5 9.5h15M5 5.5h14a1 1 0 0 1 1 1v12A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-12a1 1 0 0 1 1-1Z" />,
  folder: <path d="M3.75 6.75A1.75 1.75 0 0 1 5.5 5h4l1.7 2h7.3a1.75 1.75 0 0 1 1.75 1.75v8.5A1.75 1.75 0 0 1 18.5 19h-13a1.75 1.75 0 0 1-1.75-1.75v-10.5Z" />,
  check: <path d="m5 12.5 4.3 4.2L19 7" />,
  book: <path d="M5 4.5h10.5A2.5 2.5 0 0 1 18 7v12H7a2 2 0 0 1-2-2V4.5Zm0 0v12a2 2 0 0 0 2 2h11M8.5 8h6M8.5 11h6" />,
  automation: <path d="m13.2 2-8 10.2h6.2L10.2 22l8.6-11.3h-6.4L13.2 2Z" />,
  settings: <path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm0-5.3 1 .3.7 2.1a7 7 0 0 1 1.7.7l2-1 1.4 1.4-1 2a7 7 0 0 1 .7 1.7l2.1.7.3 1-.3 1-2.1.7a7 7 0 0 1-.7 1.7l1 2-1.4 1.4-2-1a7 7 0 0 1-1.7.7l-.7 2.1-1 .3-1-.3-.7-2.1a7 7 0 0 1-1.7-.7l-2 1-1.4-1.4 1-2a7 7 0 0 1-.7-1.7l-2.1-.7-.3-1 .3-1 2.1-.7a7 7 0 0 1 .7-1.7l-1-2L5.9 5l2 1a7 7 0 0 1 1.7-.7l.7-2.1 1-.3Z" />,
  search: <path d="m20 20-4.1-4.1m1.8-5.1a6.9 6.9 0 1 1-13.8 0 6.9 6.9 0 0 1 13.8 0Z" />,
  sun: <path d="M12 3v2m0 14v2M4.9 4.9l1.4 1.4m9.4 9.4 1.4 1.4M3 12h2m14 0h2M4.9 19.1l1.4-1.4m9.4-9.4 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />,
  moon: <path d="M20.3 15.3A8.5 8.5 0 0 1 8.7 3.7 8.6 8.6 0 1 0 20.3 15.3Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h13m-5-5 5 5-5 5" />,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  spark: <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Zm6 12 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" />,
  terminal: <path d="m5 7 5 5-5 5m7 0h7" />,
  code: <path d="m8.5 8-4 4 4 4m7-8 4 4-4 4M13 5l-2 14" />,
  database: <path d="M5 6.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5Zm0 0v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5m-14 5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" />,
  canvas: <path d="m5 17 4-4 3 3 4-5 3 3M4 4h16v16H4V4Z" />,
  git: <path d="m7 4 5 5 5-5M12 9v10M7 4v5M17 4v5M7 19h10" />,
  globe: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.1 2.4 3.2 5.4 3.2 9S14.1 18.6 12 21C9.9 18.6 8.8 15.6 8.8 12S9.9 5.4 12 3Z" />,
  research: <path d="M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12Zm0 0v12a3 3 0 0 0 3 3m3-12h5m-5 3h5m-5 3h3" />,
  memory: <path d="M7 5.5h10A2.5 2.5 0 0 1 19.5 8v8a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 16V8A2.5 2.5 0 0 1 7 5.5Zm0 0V3m10 2.5V3M7 18.5V21m10-2.5V21M4.5 9H2m2.5 5H2m17.5-5H22m-2.5 5H22M9 10h6m-6 4h4" />,
  shield: <path d="M12 3 19 6v5c0 4.8-3 8.4-7 10-4-1.6-7-5.2-7-10V6l7-3Zm-3 9 2 2 4-4" />,
  activity: <path d="M4 12h3l2-6 4 12 2-6h5" />,
  command: <path d="M7.5 7.5A2.5 2.5 0 1 1 5 5a2.5 2.5 0 0 1 2.5 2.5Zm0 0h9m-9 0v9m9-9a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 16.5 7.5Zm0 0v9m0 0A2.5 2.5 0 1 1 14 19a2.5 2.5 0 0 1 2.5-2.5Zm0 0h-9m0 0A2.5 2.5 0 1 1 5 19a2.5 2.5 0 0 1 2.5-2.5Z" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  clock: <path d="M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  bolt: <path d="m13 2-8 11h6l-1 9 8-11h-6l1-9Z" />,
  lock: <path d="M6 10h12v10H6V10Zm3 0V7a3 3 0 0 1 6 0v3m-3 4v2" />,
  refresh: <path d="M19 8V4m0 0h-4m4 0-3 3a7 7 0 1 0 1.2 8.3" />,
  external: <path d="M14 5h5v5m0-5-8 8M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
  checkCircle: <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-11 0 2 2 4-4" />,
  alert: <path d="M12 4 3 20h18L12 4Zm0 6v4m0 3h.01" />,
  loader: <path d="M12 3v3m6.4-.4-2.1 2.1M21 12h-3m.4 6.4-2.1-2.1M12 21v-3m-6.4.4 2.1-2.1M3 12h3m-.4-6.4 2.1 2.1" />,
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  label?: string;
}

export function Icon({ name, size = 18, label, className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={className}
      fill="none"
      focusable="false"
      height={size}
      role={label ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
