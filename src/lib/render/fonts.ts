import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Fonts are embedded as data URIs rather than linked to Google Fonts.
 *
 * A render that silently falls back to a system font produces a slide that
 * looks nearly right and is off-brand, and it would do so precisely when the
 * network is slow — i.e. in production. Embedding removes the failure mode.
 */

const FACES = [
  { family: "Cormorant Garamond", weight: 400, style: "normal", file: "CormorantGaramond-400-normal.ttf" },
  { family: "Cormorant Garamond", weight: 600, style: "normal", file: "CormorantGaramond-600-normal.ttf" },
  { family: "Cormorant Garamond", weight: 700, style: "normal", file: "CormorantGaramond-700-normal.ttf" },
  { family: "Cormorant Garamond", weight: 600, style: "italic", file: "CormorantGaramond-600-italic.ttf" },
  { family: "Jost", weight: 300, style: "normal", file: "Jost-300-normal.ttf" },
  { family: "Jost", weight: 400, style: "normal", file: "Jost-400-normal.ttf" },
  { family: "Jost", weight: 500, style: "normal", file: "Jost-500-normal.ttf" },
  { family: "Jost", weight: 600, style: "normal", file: "Jost-600-normal.ttf" },
  { family: "Parisienne", weight: 400, style: "normal", file: "Parisienne-400-normal.ttf" },
] as const;

let cached: string | undefined;

export async function fontFaceCss(): Promise<string> {
  if (cached) return cached;
  const dir = path.join(process.cwd(), "public", "fonts");
  const blocks = await Promise.all(
    FACES.map(async (face) => {
      const data = await readFile(path.join(dir, face.file));
      return [
        "@font-face{",
        `font-family:'${face.family}';`,
        `font-style:${face.style};`,
        `font-weight:${face.weight};`,
        "font-display:block;",
        `src:url(data:font/ttf;base64,${data.toString("base64")}) format('truetype');`,
        "}",
      ].join("");
    }),
  );
  cached = blocks.join("\n");
  return cached;
}

export const FONT_FAMILIES = {
  display: "'Cormorant Garamond', Georgia, serif",
  body: "'Jost', system-ui, sans-serif",
  script: "'Parisienne', cursive",
};
