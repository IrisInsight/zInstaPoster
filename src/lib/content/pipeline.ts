import { and, eq } from "drizzle-orm";
import { evaluate, type ComplianceReport, type ComplianceSubject } from "@/lib/compliance/engine";
import { getDb, photoGeneration, post, slide, type Post } from "@/lib/db";
import { renderSlide, isJpeg, jpegDimensions, MAX_BYTES } from "@/lib/render/renderer";
import { normalizeToJpeg } from "@/lib/render/raster";
import { putObject } from "@/lib/storage";
import { recordAudit, systemActor } from "@/lib/audit";
import type { Actor } from "@/lib/posts/state-machine";
import type { TenantConfig } from "@/lib/tenants";
import type { SlideType } from "@/lib/render/types";
import { generateCarouselCopy } from "./claude";
import { generatePhoto } from "./gemini";
import type { GeneratedCarousel } from "./schema";

export type PipelineStep =
  | "writing_copy"
  | "generating_photo"
  | "rendering_slides"
  | "running_compliance";

export const PIPELINE_STEPS: { id: PipelineStep; label: string }[] = [
  { id: "writing_copy", label: "Writing copy" },
  { id: "generating_photo", label: "Generating photo" },
  { id: "rendering_slides", label: "Rendering slides" },
  { id: "running_compliance", label: "Running compliance checks" },
];

export type PipelineEvent =
  | { type: "post"; postId: string }
  | { type: "step"; step: PipelineStep; status: "start" | "done"; detail?: string }
  | { type: "copy"; headline: string; position: number }
  | { type: "slide"; position: number; url: string }
  | { type: "done"; postId: string; approvable: boolean; findings: number }
  | { type: "error"; message: string; step?: PipelineStep };

export type Emit = (event: PipelineEvent) => void;

/** Pulls headlines out of a partial JSON stream so the UI can show copy arriving. */
export function createHeadlineTracker(emit: Emit) {
  let buffer = "";
  let seen = 0;
  return (delta: string) => {
    buffer += delta;
    const matches = [...buffer.matchAll(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    for (let i = seen; i < matches.length; i++) {
      const value = matches[i][1].replace(/\\"/g, '"').replace(/\\n/g, " ");
      emit({ type: "copy", headline: value, position: i + 1 });
    }
    seen = Math.max(seen, matches.length);
  };
}

export function complianceSubjectFor(input: {
  caption: string;
  slides: {
    position: number;
    type: string;
    copy: Record<string, unknown>;
    photoUrl?: string | null;
    photoPrompt?: string | null;
  }[];
}): ComplianceSubject {
  return {
    caption: input.caption,
    slides: input.slides.map((s) => ({
      position: s.position,
      type: s.type,
      text: flattenCopy(s.copy),
      photoPrompt: s.photoPrompt ?? null,
      hasPhoto: Boolean(s.photoUrl ?? s.photoPrompt),
    })),
  };
}

/** Every human-visible string on a slide, in reading order. */
export function flattenCopy(copy: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "photo_prompt" || key === "position" || key === "type") continue;
        walk(inner);
      }
    }
  };
  walk(copy);
  return out.filter((s) => s.trim().length > 0);
}

export interface GenerateOptions {
  tenant: TenantConfig;
  tenantId: string;
  templateName: string;
  prompt: string;
  reference?: string | null;
  igAccountId?: string | null;
  actor: Actor;
  emit?: Emit;
  signal?: AbortSignal;
}

/**
 * Claude writes the copy → Gemini generates the photo → the renderer
 * composites → four slide URLs → compliance runs over the result.
 */
export async function generatePost(options: GenerateOptions): Promise<Post> {
  const emit: Emit = options.emit ?? (() => {});
  const db = await getDb();

  emit({ type: "step", step: "writing_copy", status: "start" });
  const carousel = await generateCarouselCopy({
    tenant: options.tenant,
    templateName: options.templateName,
    prompt: options.prompt,
    reference: options.reference,
    onDelta: createHeadlineTracker(emit),
    signal: options.signal,
  });
  emit({
    type: "step",
    step: "writing_copy",
    status: "done",
    detail: `${carousel.slides.length} slides`,
  });

  const [created] = await db
    .insert(post)
    .values({
      tenantId: options.tenantId,
      igAccountId: options.igAccountId ?? null,
      template: options.templateName,
      status: "draft",
      title: carousel.title,
      prompt: options.prompt,
      caption: carousel.caption,
      altTexts: carousel.slides.map((s) => s.alt_text),
      createdBy: options.actor.label,
    })
    .returning();
  emit({ type: "post", postId: created.id });

  await recordAudit({
    tenantId: options.tenantId,
    postId: created.id,
    actor: options.actor,
    action: "post.generated",
    payload: { prompt: options.prompt, template: options.templateName },
  });

  const rows = await db
    .insert(slide)
    .values(
      carousel.slides.map((s) => ({
        postId: created.id,
        position: s.position,
        type: s.type,
        copy: { ...s.copy, kicker: carousel.kicker } as Record<string, unknown>,
        altText: s.alt_text,
        photoPrompt: (s.copy as { photo_prompt?: string }).photo_prompt ?? null,
        width: options.tenant.output.width,
        height: options.tenant.output.height,
      })),
    )
    .returning();

  await fillPhotos({ tenant: options.tenant, postId: created.id, slides: rows, emit });
  await renderPost({ tenant: options.tenant, postId: created.id, emit });
  const report = await runCompliance({ tenant: options.tenant, postId: created.id, emit });

  // A post that passes every check is waiting on a person, not on the
  // pipeline — so it lands in pending_approval. Only a human can take it
  // further. A post with blocking findings stays a draft until they are fixed.
  const [updated] = await db
    .update(post)
    .set({
      complianceReport: report,
      status: report.approvable ? "pending_approval" : "draft",
      updatedAt: new Date(),
    })
    .where(eq(post.id, created.id))
    .returning();

  if (report.approvable) {
    await recordAudit({
      tenantId: options.tenantId,
      postId: created.id,
      actor: systemActor("pipeline"),
      action: "post.pending_approval",
      payload: { from: "draft", to: "pending_approval", checksPassed: report.passed },
    });
  }

  emit({
    type: "done",
    postId: created.id,
    approvable: report.approvable,
    findings: report.findings.length,
  });
  return updated;
}

export async function fillPhotos(input: {
  tenant: TenantConfig;
  postId: string;
  slides: { id: string; position: number; photoPrompt: string | null }[];
  emit?: Emit;
}): Promise<void> {
  const emit: Emit = input.emit ?? (() => {});
  const withPhotos = input.slides.filter((s) => s.photoPrompt);
  if (withPhotos.length === 0) return;

  emit({ type: "step", step: "generating_photo", status: "start" });
  for (const row of withPhotos) {
    await generateSlidePhoto({
      tenant: input.tenant,
      postId: input.postId,
      slideId: row.id,
      position: row.position,
      prompt: row.photoPrompt as string,
    });
  }
  emit({ type: "step", step: "generating_photo", status: "done" });
}

/** Generates one photo, stores it, keeps it in the slide's generation history. */
export async function generateSlidePhoto(input: {
  tenant: TenantConfig;
  postId: string;
  slideId: string;
  position: number;
  prompt: string;
  /** The post's template, so the photo is cropped to that template's slot. */
  templateName?: string;
}): Promise<string> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  const templateName =
    input.templateName ??
    current?.template ??
    Object.keys(input.tenant.templates ?? {})[0];
  const slot = input.tenant.templates?.[templateName]?.slide_specs?.hook
    ?.photo_slot ?? { w: 1080, h: 560, x: 0, y: 0 };

  const photo = await generatePhoto({ prompt: input.prompt });
  const jpeg =
    photo.contentType === "image/jpeg"
      ? photo.buffer
      : await normalizeToJpeg(photo.buffer, photo.contentType, {
          width: slot.w,
          height: slot.h,
        });

  const stored = await putObject(
    `posts/${input.postId}/photos/${input.slideId}-${Date.now()}.jpg`,
    jpeg,
    "image/jpeg",
  );

  await db
    .update(photoGeneration)
    .set({ selected: "false" })
    .where(eq(photoGeneration.slideId, input.slideId));
  await db.insert(photoGeneration).values({
    slideId: input.slideId,
    prompt: input.prompt,
    url: stored.url,
    provider: photo.provider,
    model: photo.model,
    selected: "true",
  });
  await db
    .update(slide)
    .set({ photoUrl: stored.url, photoPrompt: input.prompt })
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));

  return stored.url;
}

/** Renders every slide of a post, or just one when `position` is given. */
export async function renderPost(input: {
  tenant: TenantConfig;
  postId: string;
  position?: number;
  emit?: Emit;
}): Promise<void> {
  const emit: Emit = input.emit ?? (() => {});
  const db = await getDb();
  const rows = await db
    .select()
    .from(slide)
    .where(
      input.position
        ? and(eq(slide.postId, input.postId), eq(slide.position, input.position))
        : eq(slide.postId, input.postId),
    )
    .orderBy(slide.position);

  emit({ type: "step", step: "rendering_slides", status: "start" });
  for (const row of rows) {
    const rendered = await renderSlide({
      tenant: input.tenant,
      slide: {
        position: row.position,
        type: row.type as SlideType,
        copy: row.copy as Record<string, unknown>,
        photoUrl: row.photoUrl,
        photoPrompt: row.photoPrompt,
      },
    });

    // Belt and braces: Instagram rejects PNG outright, rejects anything over
    // 8MB, and crops every slide to slide 1's ratio.
    if (!isJpeg(rendered.buffer)) {
      throw new Error(`Slide ${row.position} did not render as a JPEG.`);
    }
    if (rendered.bytes > MAX_BYTES) {
      throw new Error(`Slide ${row.position} is larger than Instagram's 8MB limit.`);
    }
    const dims = jpegDimensions(rendered.buffer);
    if (dims && (dims.width !== row.width || dims.height !== row.height)) {
      throw new Error(
        `Slide ${row.position} rendered ${dims.width}×${dims.height}, expected ${row.width}×${row.height}.`,
      );
    }

    const stored = await putObject(
      `posts/${input.postId}/slides/${row.position}-${Date.now()}.jpg`,
      rendered.buffer,
      "image/jpeg",
    );
    await db
      .update(slide)
      .set({
        renderedUrl: stored.url,
        bytes: rendered.bytes,
        renderedAt: new Date(),
      })
      .where(eq(slide.id, row.id));
    emit({ type: "slide", position: row.position, url: stored.url });
  }
  emit({ type: "step", step: "rendering_slides", status: "done" });
}

export async function runCompliance(input: {
  tenant: TenantConfig;
  postId: string;
  emit?: Emit;
}): Promise<ComplianceReport> {
  const emit: Emit = input.emit ?? (() => {});
  emit({ type: "step", step: "running_compliance", status: "start" });

  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  const rows = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, input.postId))
    .orderBy(slide.position);

  const report = evaluate(
    input.tenant.compliance_rules,
    complianceSubjectFor({
      caption: current.caption,
      slides: rows.map((row) => ({
        position: row.position,
        type: row.type,
        copy: row.copy as Record<string, unknown>,
        photoUrl: row.photoUrl,
        photoPrompt: row.photoPrompt,
      })),
    }),
  );

  await db
    .update(post)
    .set({ complianceReport: report, updatedAt: new Date() })
    .where(eq(post.id, input.postId));

  emit({
    type: "step",
    step: "running_compliance",
    status: "done",
    detail: report.approvable
      ? `${report.passed} checks passed`
      : `${report.findings.filter((f) => f.severity === "blocking").length} blocking`,
  });
  return report;
}

export { systemActor };
