import type { ConceptScene } from "./types.ts";
import { lifecycleScene } from "./lifecycle.ts";
import { poolingScene } from "./pooling.ts";
import { shortPollingScene } from "./shortpolling.ts";
import { longPollingScene } from "./longpolling.ts";
import { sseScene } from "./sse.ts";
import { websocketScene } from "./websocket.ts";
import { pubSubScene } from "./pubsub.ts";
import { messageQueueScene } from "./queue.ts";
import { loadBalancerScene } from "./loadbalancer.ts";
import { cacheAsideScene } from "./cache.ts";
import { nPlusOneScene } from "./nplusone.ts";
import { concurrencyScene } from "./concurrency.ts";

export * from "./types.ts";
export { World, Station, rng } from "./world.ts";

/** Animated scenes, one per full concept. */
export const SCENES: ConceptScene[] = [
  lifecycleScene, poolingScene, shortPollingScene, longPollingScene, sseScene, websocketScene,
  pubSubScene, messageQueueScene, loadBalancerScene, cacheAsideScene, nPlusOneScene, concurrencyScene,
];

export function sceneFor(conceptId: string): ConceptScene | undefined {
  return SCENES.find((s) => s.id === conceptId);
}
