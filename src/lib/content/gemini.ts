import { env } from "@/lib/env";

/**
 * Photo generation.
 *
 * The image model produces photography only. Every word of typography on a
 * slide is rendered deterministically in HTML — legal text has to be exact,
 * diffable and versionable, which a generative model cannot promise.
 *
 * Google applies SynthID watermarking to what comes back. We do not touch it.
 */

export interface GeneratedPhoto {
  buffer: Buffer;
  contentType: string;
  provider: "gemini" | "placeholder";
  model: string;
  prompt: string;
}

export function photoGenerationAvailable(): boolean {
  return Boolean(env.geminiApiKey);
}

/** Guard rails applied to every photo brief, whatever the model wrote. */
export function buildPhotoPrompt(brief: string): string {
  return [
    brief.trim(),
    "Editorial stock photography. Natural light, shallow depth of field, muted warm neutral palette.",
    "No text, no watermarks, no logos, no signage, no clinical or hospital setting, no medical equipment, no uniforms.",
    "Photorealistic, candid, unposed. Composed for a wide crop with clear space on one side.",
  ].join(" ");
}

export async function generatePhoto(input: {
  prompt: string;
  aspectRatio?: string;
}): Promise<GeneratedPhoto> {
  const prompt = buildPhotoPrompt(input.prompt);
  const aspectRatio = input.aspectRatio ?? "16:9";

  if (!env.geminiApiKey) {
    return {
      ...(await placeholderPhoto(input.prompt)),
      prompt,
    };
  }

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
  const model = env.geminiImageModel;

  // Imagen models use generateImages; the Gemini image models ("Nano Banana")
  // return image parts from generateContent.
  if (model.startsWith("imagen")) {
    const response = await ai.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio },
    });
    const image = response.generatedImages?.[0]?.image;
    if (!image?.imageBytes) {
      throw new Error("The image model returned no image.");
    }
    return {
      buffer: Buffer.from(image.imageBytes, "base64"),
      contentType: image.mimeType ?? "image/png",
      provider: "gemini",
      model,
      prompt,
    };
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio, imageSize: "2K" },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    const refusal = parts
      .map((part) => part.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    throw new Error(
      refusal
        ? `The image model returned no image: ${refusal}`
        : "The image model returned no image.",
    );
  }
  return {
    buffer: Buffer.from(imagePart.inlineData.data, "base64"),
    contentType: imagePart.inlineData.mimeType ?? "image/png",
    provider: "gemini",
    model,
    prompt,
  };
}

/**
 * Used when GEMINI_API_KEY is absent, so the pipeline still produces four
 * complete slides end to end. It is a rendered gradient, never a photograph of
 * a person, and it is labelled as a placeholder in the UI.
 */
async function placeholderPhoto(
  brief: string,
): Promise<Omit<GeneratedPhoto, "prompt">> {
  const { renderHtmlToJpeg } = await import("@/lib/render/raster");
  const hash = [...brief].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 7);
  const html = `<!doctype html><html><body style="margin:0">
  <div style="width:1080px;height:560px;background:
    radial-gradient(120% 140% at 18% 20%, hsl(${hash} 24% 86%) 0%, hsl(${(hash + 40) % 360} 18% 72%) 58%, hsl(${(hash + 70) % 360} 16% 58%) 100%);
    display:flex;align-items:flex-end;padding:28px 34px;box-sizing:border-box;
    font-family:system-ui,sans-serif;">
    <div style="font-size:15px;letter-spacing:2.6px;text-transform:uppercase;color:rgba(255,255,255,.82);">
      Placeholder — no image model configured
    </div>
  </div></body></html>`;
  const buffer = await renderHtmlToJpeg(html, { width: 1080, height: 560 });
  return {
    buffer,
    contentType: "image/jpeg",
    provider: "placeholder",
    model: "placeholder",
  };
}
