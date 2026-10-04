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
import { rateLimitingScene } from "./rate-limiting.ts";
import { reverseProxyScene } from "./reverse-proxy.ts";
import { cdnScene } from "./cdn.ts";
import { apiGatewayScene } from "./api-gateway.ts";
import { horizontalScalingScene } from "./horizontal-scaling.ts";
import { timeoutsScene } from "./timeouts.ts";
import { circuitBreakerScene } from "./circuit-breaker.ts";
import { retriesBackoffScene } from "./retries-backoff.ts";
import { idempotencyScene } from "./idempotency.ts";
import { backpressureScene } from "./backpressure.ts";
import { paginationScene } from "./pagination.ts";
import { databaseIndexScene } from "./database-index.ts";
import { readReplicaScene } from "./read-replica.ts";
import { shardingScene } from "./sharding.ts";
import { transactionsScene } from "./transactions.ts";
import { deadLetterQueueScene } from "./dead-letter-queue.ts";
import { cronScene } from "./cron.ts";
import { webhooksScene } from "./webhooks.ts";
import { sessionsJwtScene } from "./sessions-jwt.ts";
import { presignedUploadsScene } from "./presigned-uploads.ts";
import { serverActionsScene } from "./server-actions.ts";
import { threadPoolScene } from "./thread-pool.ts";

export * from "./types.ts";
export { World, Station, rng } from "./world.ts";

/** Animated scenes, one per concept. */
export const SCENES: ConceptScene[] = [
  // The twelve core concepts.
  lifecycleScene, poolingScene, shortPollingScene, longPollingScene, sseScene, websocketScene,
  pubSubScene, messageQueueScene, loadBalancerScene, cacheAsideScene, nPlusOneScene, concurrencyScene,
  // Traffic and edge.
  rateLimitingScene, reverseProxyScene, cdnScene, apiGatewayScene, horizontalScalingScene,
  // Reliability.
  timeoutsScene, circuitBreakerScene, retriesBackoffScene, idempotencyScene, backpressureScene,
  // Data.
  paginationScene, databaseIndexScene, readReplicaScene, shardingScene, transactionsScene,
  // Async work.
  deadLetterQueueScene, cronScene, webhooksScene,
  // Security and the runtime.
  sessionsJwtScene, presignedUploadsScene, serverActionsScene, threadPoolScene,
];

export function sceneFor(conceptId: string): ConceptScene | undefined {
  return SCENES.find((s) => s.id === conceptId);
}
