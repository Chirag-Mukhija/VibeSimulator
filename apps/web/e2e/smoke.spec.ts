import { expect, test } from "@playwright/test";

test("home lists the gallery", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("gallery-card")).toHaveCount(3);
});

test("a flow plays hop by hop with code evidence", async ({ page }) => {
  await page.goto("/#/repo/job-scheduler");
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
  await expect(page.getByTestId("finding")).toHaveCount(9);
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
