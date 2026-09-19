import { getBrowser } from "./browser";
import { slideHtml } from "./templates";
import type { RenderRequest } from "./types";

export interface RenderedSlide {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  contentType: "image/jpeg";
}

/**
 * Instagram's constraints, which the renderer exists to satisfy:
 *   JPEG only (PNG is rejected), sRGB, ≤ 8MB, 320–1440px wide,
 *   and every slide in a carousel at identical dimensions — Instagram crops
 *   slides 2..n to slide 1's aspect ratio.
 */
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_WIDTH = 1440;
export const MIN_WIDTH = 320;

const QUALITY_LADDER = [92, 86, 78, 70, 60];

export async function renderSlide(
  request: RenderRequest,
): Promise<RenderedSlide> {
  const width = request.tenant.output?.width ?? 1080;
  const height = request.tenant.output?.height ?? 1350;

  if (width > MAX_WIDTH || width < MIN_WIDTH) {
    throw new Error(
      `Tenant output width ${width}px is outside Instagram's ${MIN_WIDTH}–${MAX_WIDTH}px range.`,
    );
  }

  const html = await slideHtml(request);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-fitted") === "true",
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(() => document.fonts.ready);

    for (const quality of QUALITY_LADDER) {
      const buffer = await page.screenshot({
        type: "jpeg",
        quality,
        clip: { x: 0, y: 0, width, height },
      });
      if (buffer.byteLength <= MAX_BYTES) {
        return {
          buffer: Buffer.from(buffer),
          width,
          height,
          bytes: buffer.byteLength,
          contentType: "image/jpeg",
        };
      }
    }
    throw new Error(
      `Slide ${request.slide.position} exceeds Instagram's ${MAX_BYTES} byte limit even at the lowest quality.`,
    );
  } finally {
    await context.close();
  }
}

/** True when the buffer starts with the JPEG SOI marker and ends with EOI. */
export function isJpeg(buffer: Buffer): boolean {
  return (
    buffer.length > 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}

/** Reads width/height out of a JPEG's SOFn marker, to verify what we uploaded. */
export function jpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + size;
  }
  return undefined;
}
