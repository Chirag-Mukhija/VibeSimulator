import { expect, test } from "@playwright/test";

test("home lists the gallery", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("gallery-card")).toHaveCount(4);
});

test("a flow plays hop by hop with code evidence", async ({ page }) => {
  await page.goto("/#/repo/job-scheduler?tab=flows");
  await page.getByTestId("flow-item").filter({ hasText: "On \"job:events\" message" }).click();
  await expect(page.getByTestId("flow-title")).toHaveText("On \"job:events\" message");
  await page.getByTestId("play").click(); // pause autoplay
  const progress = page.locator(".progress");
  for (let i = 0; i < 2; i++) await page.getByTestId("next").click();
  await expect(progress).toHaveText(/^3 \/ \d+$/);
  // Third item: the subscriber's broadcast pushes over every open WebSocket.
  await expect(page.getByTestId("caption")).toContainText("pushes a message");
  const inspector = page.getByTestId("inspector");
  await expect(inspector.locator(".code-line.hl")).toContainText("ws.send(raw)");
  await expect(inspector).toContainText("api/ws/broadcast.js");
});

test("findings link back into the flow", async ({ page }) => {
  await page.goto("/#/repo/job-scheduler?tab=findings");
  await expect(page.getByTestId("finding")).toHaveCount(8);
  const card = page.getByTestId("finding").filter({ hasText: "Each pushed message" });
  await card.getByRole("button", { name: "Show in flow" }).click();
  await expect(page.getByTestId("flow-title")).toHaveText("On \"job:events\" message");
  await expect(page.getByTestId("inspector").getByTestId("finding")).toContainText("Each pushed message");
});

test("the map shows processes and what they talk to", async ({ page }) => {
  await page.goto("/#/repo/instabackend?tab=map");
  const map = page.getByTestId("system-map");
  await expect(map).toContainText("nginx reverse proxy");
  await expect(map).toContainText("Postgres");
  await expect(map).toContainText("Redis");
  await expect(map).toContainText("AWS S3");
});

test("a dropped file that is not a trace shows a readable error", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"nope":true}') });
  await expect(page.locator(".error-box")).toContainText("not a valid vibeSimulator trace");
});

test("a Learn page asks for a prediction, then shows the simulated result", async ({ page }) => {
  await page.goto("/#/learn/connection-pooling");
  await expect(page.getByTestId("learn-page")).toContainText("The problem it solves");
  await expect(page.getByTestId("predict")).toBeVisible();
  await page.getByTestId("predict-option").first().click();
  await expect(page.getByTestId("sim-result")).toBeVisible();
  await expect(page.getByTestId("guess-result")).toContainText("The simulation says");
  await page.getByTestId("why").click();
  await expect(page.getByTestId("sim-result").locator(".fix")).toBeVisible();
});

test("every full concept has a working simulation", async ({ page }) => {
  await page.goto("/#/learn");
  const full = page.getByTestId("concept-card").filter({ hasText: "simulation" });
  await expect(full).toHaveCount(12);
  for (const id of ["http-request-lifecycle", "short-polling", "long-polling", "server-sent-events", "websocket", "pub-sub", "message-queue", "load-balancer", "cache-aside", "n-plus-one", "concurrency-models"]) {
    await page.goto(`/#/learn/${id}`);
    await page.getByRole("button", { name: "Skip, just run it" }).click();
    await expect(page.getByTestId("sim-result").locator(".metric").first()).toBeVisible();
  }
});

test("the deep-dive drawer embeds the concept's simulation", async ({ page }) => {
  await page.goto("/#/repo/paytmentgateway?tab=map");
  await page.getByTestId("system-map").getByRole("button", { name: /Postgres/ }).click();
  await page.getByTestId("inspector").getByRole("button", { name: /Connection pooling/ }).click();
  await expect(page.getByTestId("deep-dive").getByTestId("simlab")).toBeVisible();
});

test("the overview explains the repo and runs the guided tour", async ({ page }) => {
  await page.goto("/#/repo/job-scheduler");
  const overview = page.getByTestId("overview");
  await expect(overview).toContainText("6 HTTP routes in the api process, plus a separate worker process");
  await expect(overview).toContainText("Talking points");
  await expect(page.getByTestId("tour-stop")).toHaveCount(5);
  await page.getByTestId("start-tour").click();
  await expect(page.getByTestId("flow-title")).toHaveText("POST /jobs");
  await expect(page.getByTestId("tour-bar")).toContainText("Tour stop 1 of 5");
  await page.getByTestId("tour-next").click();
  await expect(page.getByTestId("flow-title")).toContainText("Loop: poll");
  await expect(page.getByTestId("tour-bar")).toContainText("Tour stop 2 of 5");
});

test("the open-source gallery repo loads", async ({ page }) => {
  await page.goto("/#/repo/hackathon-starter?tab=flows&flow=flow%3Aroute%3APOST%3A%2Fsignup");
  await expect(page.getByTestId("flow-title")).toHaveText("POST /signup");
  // The app's MongoDB (Mongoose) and connect-mongo's separate session store.
  await expect(page.locator(".lifeline-head").filter({ hasText: "MongoDB" })).toHaveCount(2);
});

test("scale mode finds the bottleneck and a what-if relieves it", async ({ page }) => {
  await page.goto("/#/repo/instabackend?tab=scale&flow=flow%3Aroute%3APOST%3A%2Fapi%2Fauth%2Fregister");
  const scale = page.getByTestId("scale");
  await expect(scale.getByRole("heading", { name: /Scale: POST \/api\/auth\/register/ })).toBeVisible();
  // About 52 signups/s: past the ~15/s that one instance's four hashing threads can do at bcrypt cost 12.
  await scale.getByLabel(/Requests per second/).fill("400");
  const outcome = page.getByTestId("outcome");
  await expect(outcome.first()).toContainText(/Bottleneck: .*Thread pool/i, { timeout: 15_000 });
  await scale.getByLabel(/App instances/).fill("400"); // 7 instances
  await expect(outcome).toHaveCount(2, { timeout: 15_000 });
  await expect(outcome.nth(1)).toContainText("With your changes");
  await expect(outcome.nth(1)).not.toContainText(/Bottleneck: .*Thread pool/i);
});

test("scale defaults to the busiest request when no flow is chosen", async ({ page }) => {
  await page.goto("/#/repo/job-scheduler?tab=scale");
  await expect(page.getByRole("heading", { name: "Scale: POST /jobs" })).toBeVisible();
  await expect(page.getByTestId("scale-result")).toBeVisible({ timeout: 15_000 });
  // Only what-ifs that apply to this flow are offered: it writes, so no read cache.
  await expect(page.getByTestId("whatif-cache")).toHaveCount(0);
  await page.goto("/#/repo/job-scheduler?tab=scale&flow=flow%3Aroute%3AGET%3A%2Fstats");
  await expect(page.getByTestId("whatif-cache")).toBeVisible();
});

test("long pages scroll inside the workspace instead of being cut off", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/#/repo/hackathon-starter?tab=findings");
  const wrap = page.locator(".stage .map-wrap");
  await expect(page.getByTestId("findings")).toBeVisible();
  const { scrollHeight, clientHeight } = await wrap.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(clientHeight).toBeLessThan(600);
  expect(scrollHeight).toBeGreaterThan(clientHeight);
});

test("scale mode still works where Web Workers are blocked", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { Worker: unknown }).Worker = function () {
      throw new Error("workers blocked");
    };
  });
  await page.goto("/#/repo/job-scheduler?tab=scale");
  await expect(page.getByTestId("scale-result")).toBeVisible({ timeout: 15_000 });
});
