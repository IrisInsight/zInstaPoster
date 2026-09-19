import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { assertTenantAccess, requireUser } from "@/lib/auth";
import { getDb, igAccount } from "@/lib/db";
import { loadPost, photoHistory } from "@/lib/posts/service";
import type { ComplianceReport } from "@/lib/compliance/engine";
import { ReviewScreen } from "@/components/review/review-screen";
import { nextWindows } from "@/lib/posting-windows";
import { photoGenerationAvailable } from "@/lib/content/gemini";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  let loaded;
  try {
    loaded = await loadPost(id);
  } catch {
    notFound();
  }
  await assertTenantAccess(user, loaded.tenantId);

  const db = await getDb();
  const accounts = await db
    .select()
    .from(igAccount)
    .where(eq(igAccount.tenantId, loaded.tenantId));

  const hookSlide = loaded.slides.find((s) => s.photoPrompt);
  const generations = hookSlide
    ? await photoHistory({ postId: id, slideId: hookSlide.id })
    : [];

  const windows = nextWindows({
    windows: loaded.tenant.compliance_rules?.posting_windows ?? {},
    timeZone: loaded.tenant.timezone,
    count: 4,
  });

  return (
    <ReviewScreen
      post={{
        id: loaded.post.id,
        status: loaded.post.status,
        title: loaded.post.title,
        caption: loaded.post.caption,
        approvedBy: loaded.post.approvedBy,
        approvedAt: loaded.post.approvedAt?.toISOString() ?? null,
        scheduledFor: loaded.post.scheduledFor?.toISOString() ?? null,
        igAccountId: loaded.post.igAccountId,
        failureReason: loaded.post.failureReason,
      }}
      slides={loaded.slides.map((s) => ({
        id: s.id,
        position: s.position,
        type: s.type,
        copy: s.copy as Record<string, unknown>,
        altText: s.altText,
        photoPrompt: s.photoPrompt,
        photoUrl: s.photoUrl,
        renderedUrl: s.renderedUrl,
        bytes: s.bytes,
        width: s.width,
        height: s.height,
      }))}
      report={(loaded.post.complianceReport ?? null) as ComplianceReport | null}
      tenant={{
        name: loaded.tenant.name,
        timezone: loaded.tenant.timezone,
        disclaimers: loaded.tenant.disclaimers ?? {},
      }}
      accounts={accounts.map((a) => ({
        id: a.id,
        username: a.username,
        status: a.status,
      }))}
      photoGenerations={generations.map((g) => ({
        id: g.id,
        slideId: g.slideId,
        url: g.url,
        prompt: g.prompt,
        provider: g.provider,
        selected: g.selected === "true",
      }))}
      windowSuggestions={windows.map((w) => ({
        at: w.at.toISOString(),
        label: w.label,
      }))}
      photoAvailable={photoGenerationAvailable()}
    />
  );
}
