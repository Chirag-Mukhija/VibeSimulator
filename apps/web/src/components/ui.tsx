import type { ReactNode } from "react";
import type { TraceNode } from "@vibesim/spec";
import { kindInfo, type KindGroup } from "../lib/explain.ts";
import type { Severity } from "../lib/model.ts";

export function groupColor(group: KindGroup): string {
  return `var(--k-${group})`;
}

export function nodeColor(node: Pick<TraceNode, "kind">): string {
  return groupColor(kindInfo(node.kind).group);
}

const PATHS: Record<string, ReactNode> = {
  client: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" /></>,
  "ui-event": <><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M8 20h8M12 16.5V20" /></>,
  timer: <><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2M9.5 3h5" /></>,
  proxy: <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /></>,
  route: <><path d="M4 12h12M12 6l6 6-6 6" /></>,
  "ws-endpoint": <><path d="M8 8h-.5a4 4 0 0 0 0 8H8M16 8h.5a4 4 0 0 1 0 8H16M8.5 12h7" /></>,
  "sse-endpoint": <><path d="M5 12h3l2-5 4 10 2-5h3" /></>,
  middleware: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  handler: <><path d="M9 5 5 12l4 7M15 5l4 7-4 7" /></>,
  service: <><path d="M9 5 5 12l4 7M15 5l4 7-4 7" /></>,
  worker: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></>,
  cache: <><path d="M13 3 6 13.5h5L10 21l8-11h-5z" /></>,
  queue: <><rect x="4" y="5" width="16" height="4" rx="1" /><rect x="4" y="10" width="16" height="4" rx="1" /><rect x="4" y="15" width="16" height="4" rx="1" /></>,
  topic: <><path d="M4 12h3M17 12h3M7 12a5 5 0 0 1 10 0M7 12a5 5 0 0 0 10 0" /><circle cx="12" cy="12" r="1.5" /></>,
  "external-api": <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" /></>,
  compute: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  unknown: <><circle cx="12" cy="12" r="8" strokeDasharray="3 3" /><path d="M10 9.5a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.8M12 16h.01" /></>,
  server: <><rect x="4" y="4" width="16" height="7" rx="1.5" /><rect x="4" y="13" width="16" height="7" rx="1.5" /><path d="M8 7.5h.01M8 16.5h.01M12 7.5h5M12 16.5h5" /></>,
  laptop: <><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M3 19h18" /></>,
};

export function NodeIcon({ kind, size = 16, color }: { kind: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kind] ?? PATHS.unknown}
    </svg>
  );
}

export function KindChip({ node }: { node: Pick<TraceNode, "kind"> }) {
  const info = kindInfo(node.kind);
  const color = nodeColor(node);
  return (
    <span className="chip" style={{ color, borderColor: "transparent", background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      <NodeIcon kind={node.kind} size={13} color={color} />
      {info.title}
    </span>
  );
}

export function SevDot({ severity }: { severity?: Severity }) {
  return severity ? <span className={`sev ${severity}`} title={`${severity} severity finding`} /> : <span className="sev" style={{ visibility: "hidden" }} />;
}

export function Icon({ name, size = 16 }: { name: "play" | "pause" | "step" | "back" | "restart" | "sun" | "moon" | "menu" | "close" | "upload" | "external" | "book"; size?: number }) {
  const p: Record<string, ReactNode> = {
    play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
    step: <path d="M6 5v14l9-7zM17 5v14" />,
    back: <path d="M18 5v14l-9-7zM7 5v14" />,
    restart: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
    external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
    book: <path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h9" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name]}
    </svg>
  );
}

/** A traced path: where a request starts, the hops it turns through, where it lands. */
export function BrandMark() {
  return (
    <span className="brand-mark">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 5.5v6.5h12v6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="6" cy="5.5" r="2.2" fill="currentColor" />
        <circle cx="18" cy="18.5" r="2.6" fill="var(--accent)" />
      </svg>
    </span>
  );
}
