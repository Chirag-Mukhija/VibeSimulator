import { expect, test } from "@playwright/test";

// Every concept scene, under its defaults and each "Try this" experiment: no box content spills out of its box,
// and no one-line text is cut off. Scenes change as they run, so each is sampled a few times.
test.describe.configure({ mode: "parallel" });

const audit = () => {
  const out: string[] = [];
  for (const box of document.querySelectorAll<HTMLElement>(".cbox")) {
    const b = box.getBoundingClientRect();
    const name = box.querySelector(".cbox-name b")?.textContent ?? "?";
    for (const el of box.querySelectorAll<HTMLElement>(".cbox-head, .cbox-slots, .cbox-queue, .cbox-note")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > b.bottom + 0.5 || r.right > b.right + 0.5) out.push(`${name}: ${el.className.split(" ")[0]} spills out of the box`);
    }
    for (const el of box.querySelectorAll<HTMLElement>(".ellipsis")) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${name}: "${el.textContent?.slice(0, 50)}" is cut off`);
    }
  }
  return out;
};

const IDS = [
  "http-request-lifecycle", "connection-pooling", "short-polling", "long-polling", "server-sent-events", "websocket", "pub-sub",
  "message-queue", "load-balancer", "cache-aside", "n-plus-one", "concurrency-models", "rate-limiting", "reverse-proxy", "cdn",
  "api-gateway", "horizontal-scaling", "timeouts", "circuit-breaker", "retries-backoff", "idempotency", "backpressure", "pagination",
  "database-index", "read-replica", "sharding", "transactions", "dead-letter-queue", "cron", "webhooks", "sessions-jwt",
  "presigned-uploads", "server-actions", "thread-pool",
];

for (const id of IDS) {
  test(`scene ${id}: every box's content fits`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`/#/learn/${id}`);
    const scene = page.getByTestId("concept-scene");
    await scene.scrollIntoViewIfNeeded();
    await scene.getByLabel("Speed").selectOption("2");
    const problems = new Set<string>();
    const sample = async (when: string) => (await page.evaluate(audit)).forEach((p) => problems.add(`${when}: ${p}`));
    await page.waitForTimeout(2000);
    await sample("defaults");
    await page.waitForTimeout(5000);
    await sample("defaults later");
    const tries = await scene.locator(".try-item").count();
    for (let i = 0; i < tries; i++) {
      await scene.locator(".try-item").nth(i).click();
      await page.waitForTimeout(5000);
      await sample(`try ${i + 1}`);
    }
    expect([...problems]).toEqual([]);
  });
}
