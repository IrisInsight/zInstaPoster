import { getBrowser } from "./browser";

/**
 * Small raster helpers built on the same Chromium the slide renderer uses.
 *
 * normalizeToJpeg exists because image models return PNG. PNG is rejected by
 * Instagram, and the rule "no PNG anywhere in the pipeline" is easier to hold
 * than to audit later, so generated photos are converted on arrival.
 */

export async function renderHtmlToJpeg(
  html: string,
  size: { width: number; height: number },
  quality = 88,
): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const buffer = await page.screenshot({
      type: "jpeg",
      quality,
      clip: { x: 0, y: 0, ...size },
    });
    return Buffer.from(buffer);
  } finally {
    await context.close();
  }
}

export async function normalizeToJpeg(
  input: Buffer,
  contentType: string,
  size: { width: number; height: number },
): Promise<Buffer> {
  const dataUri = `data:${contentType};base64,${input.toString("base64")}`;
  const html = `<!doctype html><html><body style="margin:0;background:#000">
    <img src="${dataUri}" style="width:${size.width}px;height:${size.height}px;object-fit:cover;display:block;">
  </body></html>`;
  return renderHtmlToJpeg(html, size, 90);
}
