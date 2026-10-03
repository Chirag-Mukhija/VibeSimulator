import { expect, test, type Page } from "@playwright/test";

// Layout audit: every page of every gallery repo at phone, tablet, laptop and wide
// widths. Checks structure rather than pixels, so it catches the classic breakages
// (sideways scroll, panels wrapping to a second row, clipped or off-screen content,
// overlapping controls) without brittle screenshots. SHOTS=<dir> also saves a
// screenshot of every page there for a visual pass.

const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "laptop-l", width: 1536, height: 864 },
  { name: "desktop", width: 1920, height: 1080 },
  { name: "wide", width: 2560, height: 1440 },
  { name: "laptop-dark", width: 1536, height: 864, dark: true },
];

const REPOS = ["job-scheduler", "instabackend", "paytmentgateway", "hackathon-starter"];
const TABS = ["overview", "flows", "map", "findings", "scale"];
const CONCEPTS = ["connection-pooling", "short-polling", "websocket", "message-queue", "load-balancer", "concurrency-models"];

const PAGES: { name: string; url: string; ready: string; then?: (page: Page) => Promise<void> }[] = [
  { name: "home", url: "/#/", ready: "[data-testid=gallery-card]" },
  { name: "learn", url: "/#/learn", ready: "[data-testid=concept-card]" },
  ...CONCEPTS.map((id) => ({ name: `learn-${id}`, url: `/#/learn/${id}`, ready: "[data-testid=learn-page]" })),
  ...REPOS.flatMap((repo) => TABS.map((tab) => ({
    name: `${repo}-${tab}`,
    url: `/#/repo/${repo}?tab=${tab}`,
    ready: tab === "scale" ? "[data-testid=scale-result]" : tab === "findings" ? "[data-testid=findings]" : tab === "flows" ? "[data-testid=topology]" : ".stage > .map-wrap, .stage .overview",
  }))),
  ...REPOS.map((repo) => ({
    name: `${repo}-flows-inspector`,
    url: `/#/repo/${repo}?tab=flows`,
    ready: "[data-testid=topology]",
    then: async (page: Page) => {
      await page.locator(".dev-stages li button").nth(1).click();
      const close = page.getByRole("button", { name: "Close details" });
      if (await close.isVisible()) await close.click();
      await page.getByTestId("event-list").locator("tr[data-index='4']").click();
      await page.waitForTimeout(250);
    },
  })),
  {
    name: "job-scheduler-tour",
    url: "/#/repo/job-scheduler",
    ready: ".overview",
    then: async (page: Page) => {
      await page.getByRole("button", { name: /Start the guided tour/ }).click();
      await page.getByTestId("tour-bar").waitFor();
    },
  },
  {
    name: "instabackend-deep-dive",
    url: "/#/repo/instabackend",
    ready: ".overview",
    then: async (page: Page) => {
      await page.getByRole("button", { name: /Connection pooling/ }).first().click();
      await page.locator(".drawer").waitFor();
    },
  },
];

/** Runs in the page; returns human-readable problems. */
function audit(): string[] {
  const problems: string[] = [];
  const vw = window.innerWidth;
  const describe = (el: Element) => {
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `<${el.tagName.toLowerCase()}${cls}> "${text}"`;
  };
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Closed drawers sit off-screen on purpose.
  const inClosedDrawer = (el: Element) => !!el.closest(".sidebar:not(.open), .inspector:not(.open)") && getComputedStyle(el.closest(".sidebar, .inspector")!).position === "fixed";
  const scrollsX = (el: Element | null): boolean => {
    for (let p = el?.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
    }
    return false;
  };

  // 1. The page itself never scrolls sideways.
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) problems.push(`page scrolls sideways: ${sw}px wide in a ${vw}px viewport`);

  // 2. Workspace panels share one row at full height.
  const ws = document.querySelector(".workspace");
  if (ws) {
    const wr = ws.getBoundingClientRect();
    for (const child of Array.from(ws.children)) {
      if (!visible(child) || getComputedStyle(child).position === "fixed") continue;
      const r = child.getBoundingClientRect();
      if (Math.abs(r.top - wr.top) > 1 || Math.abs(r.height - wr.height) > 1) {
        problems.push(`workspace panel off its row: ${describe(child)} top ${Math.round(r.top - wr.top)}, height ${Math.round(r.height)} of ${Math.round(wr.height)}`);
      }
    }
    if (ws.scrollHeight > ws.clientHeight + 1) problems.push(`workspace content taller than the workspace (${ws.scrollHeight} > ${ws.clientHeight}): something isn't scrolling`);
  }

  // 3. Nothing pokes out of the viewport unless it lives in a scroller.
  const all = Array.from(document.querySelectorAll("body *")).filter((el) => visible(el) && !inClosedDrawer(el));
  for (const el of all) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scrollsX(el) && getComputedStyle(el).position !== "fixed") {
      problems.push(`off-screen horizontally: ${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  }

  // 4. Clipped content: hidden overflow that actually hides something (ellipsis is intentional).
  for (const el of all) {
    const s = getComputedStyle(el);
    const clipsX = s.overflowX === "hidden" || s.overflowX === "clip";
    const clipsY = s.overflowY === "hidden" || s.overflowY === "clip";
    if (clipsX && s.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      problems.push(`clips content horizontally: ${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
    if (clipsY && !el.classList.contains("workspace") && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && s.textOverflow !== "ellipsis") {
      problems.push(`clips content vertically: ${describe(el)} (${el.scrollHeight} > ${el.clientHeight})`);
    }
  }

  // 5. Top bar items never overlap.
  const bar = document.querySelector(".topbar");
  if (bar) {
    const items = Array.from(bar.children).filter(visible).filter((el) => !el.classList.contains("spacer"));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!.getBoundingClientRect();
        const b = items[j]!.getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          problems.push(`top bar items overlap: ${describe(items[i]!)} and ${describe(items[j]!)}`);
        }
      }
    }
  }
  return [...new Set(problems)].slice(0, 25);
}

for (const vp of VIEWPORTS) {
  test.describe(`layout at ${vp.name} (${vp.width}px)`, () => {
    test.describe.configure({ mode: "parallel" });
    test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: "dark" in vp ? "dark" : "light" });
    for (const p of PAGES) {
      test(p.name, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
        page.on("console", (m) => { if (m.type() === "error") errors.push(`console error: ${m.text()}`); });
        await page.goto(p.url);
        await page.locator(p.ready).first().waitFor({ timeout: 15_000 });
        if (p.then) await p.then(page);
        await page.waitForTimeout(400); // let animations and the scale worker settle
        const problems = await page.evaluate(audit);
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${vp.name}/${p.name}.png`, fullPage: false });
        expect([...errors, ...problems], `${p.name} at ${vp.width}px`).toEqual([]);
      });
    }
  });
}
