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
