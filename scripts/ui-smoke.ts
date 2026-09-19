/**
 * Walks every screen against a running server and fails if one does not render
 * its real content. Catches the class of breakage a type-check cannot: a server
 * component that throws, a query that returns nothing, an image that 404s.
 *
 *   npm run dev            # in one terminal
 *   npm run ui:smoke       # in another
 *
 * Set SMOKE_BASE_URL and SMOKE_ACCESS_CODE to point it elsewhere.
 */
import { chromium } from "playwright-core";
import { chromiumExecutableOverride } from "@/lib/env";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ACCESS_CODE = process.env.SMOKE_ACCESS_CODE ?? process.env.ACCESS_CODE ?? "zinstaposter";

async function main() {
  const executablePath =
    chromiumExecutableOverride() ??
    (process.env.PLAYWRIGHT_BROWSERS_PATH
      ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`
      : undefined);

  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  });
  const page = await context.newPage();

  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === new URL(BASE).origin) {
      badResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const failures: string[] = [];

  async function visit(path: string, expected: string[]): Promise<string> {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const body = await page.locator("body").innerText();
    const missing = expected.filter((text) => !body.includes(text));
    if (missing.length > 0) {
      failures.push(`${path} is missing: ${missing.join(", ")}`);
      console.log(`  ✗ ${path}`);
    } else {
      console.log(`  ✓ ${path}`);
    }
    return body;
  }

  console.log(`walking ${BASE}\n`);

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("input[name=code]", ACCESS_CODE);
  await page.click("button[type=submit]");
  await page.waitForTimeout(2500);
  if (page.url().includes("/login")) {
    throw new Error(
      "The access code was rejected. Check ACCESS_CODE and that npm run db:seed has run.",
    );
  }
  console.log("  ✓ /login");

  await visit("/", ["Queue"]);
  await visit("/compose", ["New post", "one prompt, four slides"]);
  await visit("/accounts", ["Accounts", "Instagram Login"]);

  const queueHtml = await page.evaluate(async () => {
    const response = await fetch("/");
    return response.text();
  });
  const reviewPath = queueHtml.match(/\/posts\/[0-9a-f-]+\/review/)?.[0];
  if (reviewPath) {
    await visit(reviewPath, ["CAPTION", "SLIDES", "ACCOUNT"]);
    await visit(reviewPath.replace("/review", ""), [
      "RECORD",
      "AUDIT TRAIL",
      "CAPTION AS PUBLISHED",
    ]);
    const loaded = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll("img[src*='/api/media/'], img[src*='blob']")).filter(
          (img) => (img as HTMLImageElement).naturalWidth > 0,
        ).length,
    );
    console.log(`  ✓ ${loaded} rendered slide images load on the post detail`);
    if (loaded === 0) failures.push("No slide images loaded on the post detail.");
  } else {
    console.log("  — no posts in the queue, skipped review and detail");
  }

  await browser.close();

  if (pageErrors.length > 0) {
    failures.push(`Uncaught page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
  }
  if (badResponses.length > 0) {
    failures.push(`Failed responses: ${badResponses.slice(0, 3).join(" | ")}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log("\nevery screen rendered");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
