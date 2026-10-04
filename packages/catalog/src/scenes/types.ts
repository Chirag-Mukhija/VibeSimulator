/**
 * Concept scenes: small animated systems that show how a concept behaves, in the same
 * boxes-and-packets language as the flow view. Pure logic, no rendering: the web app draws
 * the frames. Each scene is a tiny agent-based simulation, slowed down so it can be watched.
 */

export type SceneControl =
  | { type: "choice"; id: string; label: string; options: { value: string; label: string }[] }
  | { type: "toggle"; id: string; label: string }
  | { type: "count"; id: string; label: string; min: number; max: number };

export type SceneParams = Record<string, string | number | boolean>;

export type BoxKind =
  | "users" | "browser" | "proxy" | "balancer" | "server" | "app" | "database" | "cache" | "queue" | "channel" | "worker" | "thread" | "dns"
  /** A third-party service (Stripe, an email provider), a file store (S3), a scheduler's clock, an API gateway, a CDN edge location. */
  | "external" | "storage" | "clock" | "gateway" | "edge";

export interface SceneBox {
  id: string;
  kind: BoxKind;
  label: string;
  detail?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneLink {
  id: string;
  from: string;
  to: string;
  /** Short label at the midpoint: "HTTP", "SQL". */
  label?: string;
  /** Drawn as a solid, always-open connection (a WebSocket, an SSE stream). */
  persistent?: boolean;
}

export interface BoxState {
  /** One short line under the label: "3 in progress", "max 10". */
  note?: string;
  /** Fixed capacity drawn as squares, filled when in use; `label` says what one square is. */
  slots?: { total: number; busy: number; label?: string };
  /** How many are waiting in line here. */
  queue?: number;
  tone?: "ok" | "busy" | "bad" | "idle";
}

export type TokenKind = "request" | "reply" | "push" | "empty" | "error" | "handshake";

export interface Token {
  id: number;
  link: string;
  /** 0..1 along the link. */
  t: number;
  /** Travelling from the link's `to` back to its `from`. */
  reverse: boolean;
  kind: TokenKind;
  label?: string;
}

export interface Counter {
  label: string;
  value: string;
  tone?: "good" | "bad";
}

export interface Frame {
  boxes: Record<string, BoxState>;
  tokens: Token[];
  counters: Counter[];
  /** What just happened, newest last, in plain words. */
  log: string[];
}

export interface SceneRun {
  /** Advances the scene by `dt` milliseconds of scene time and returns what to draw. */
  tick(dt: number): Frame;
}

export interface ConceptScene {
  /** The concept id this scene illustrates. */
  id: string;
  title: string;
  /** One or two sentences: what you are looking at. */
  intro: string;
  width: number;
  height: number;
  controls: SceneControl[];
  defaults: SceneParams;
  layout(params: SceneParams): { boxes: SceneBox[]; links: SceneLink[] };
  start(params: SceneParams, seed?: number): SceneRun;
  /** Guided experiments: a sentence and the settings that show it. */
  tryThis: { text: string; params: SceneParams }[];
}

export const pnum = (p: SceneParams, id: string) => Number(p[id]);
export const pstr = (p: SceneParams, id: string) => String(p[id]);
export const pbool = (p: SceneParams, id: string) => p[id] === true || p[id] === "true";
