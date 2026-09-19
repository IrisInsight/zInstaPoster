import type { Browser } from "playwright-core";
import { chromiumExecutableOverride } from "@/lib/env";

/**
 * One Chromium, resolved three ways:
 *   1. CHROMIUM_EXECUTABLE_PATH, if set.
 *   2. @sparticuz/chromium — the serverless build, used on Vercel.
 *   3. Playwright's own download, used locally.
 *
 * The browser is cached across invocations because cold-starting Chromium is
 * the single most expensive thing in the render path.
 */

let browserPromise: Promise<Browser> | undefined;

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");

  const override = chromiumExecutableOverride();
  if (override) {
    return chromium.launch({
      executablePath: override,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    });
  }

  const inLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const onVercel = inLambda || Boolean(process.env.VERCEL);
  if (onVercel) {
    const mod = await import("@sparticuz/chromium");
    // The package is CJS; under some bundlers the namespace is the default.
    const sparticuz = (mod.default ?? mod) as unknown as {
      args: string[];
      executablePath: (input?: string) => Promise<string>;
    };
    // --single-process is how the package survives a Lambda's tiny /dev/shm.
    // In a build container, which is an ordinary VM, it crashes Chromium on
    // the first newPage() with "Target page, context or browser has been
    // closed" -- an error that says nothing about the flag that caused it.
    const args = inLambda
      ? sparticuz.args
      : sparticuz.args.filter((arg) => arg !== "--single-process");
    return chromium.launch({
      executablePath: await sparticuz.executablePath(),
      args: [...args, "--font-render-hinting=none"],
      headless: true,
    });
  }

  const local = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`
    : undefined;
  return chromium.launch({
    ...(local ? { executablePath: local } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
}

export function getBrowser(): Promise<Browser> {
  browserPromise ??= launch().catch((error) => {
    browserPromise = undefined;
    throw error;
  });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const current = browserPromise;
  browserPromise = undefined;
  if (current) {
    const browser = await current.catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
