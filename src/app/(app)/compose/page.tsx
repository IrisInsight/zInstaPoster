import { requireUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant-context";
import { getDb, igAccount } from "@/lib/db";
import { eq } from "drizzle-orm";
import { ComposeForm } from "@/components/compose-form";
import { copyGenerationAvailable } from "@/lib/content/claude";
import { photoGenerationAvailable } from "@/lib/content/gemini";
import { minimumSlides, primaryTemplate } from "@/lib/tenants";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const user = await requireUser();
  const context = await getTenantContext(user);
  if (!context) return null;

  const db = await getDb();
  const accounts = await db
    .select()
    .from(igAccount)
    .where(eq(igAccount.tenantId, context.active.id));

  // Primary first: templates round-trip through a jsonb column, which does not
  // preserve the order they were written in.
  const primary = primaryTemplate(context.config);
  const templates = Object.entries(context.config.templates ?? {})
    .map(([name, template]) => ({
      name,
      slides: template.slides,
      minSlides: minimumSlides(template),
      useWhen: template.use_when ?? "",
    }))
    .sort((a, b) =>
      a.name === primary ? -1 : b.name === primary ? 1 : a.name.localeCompare(b.name),
    );

  return (
    <div className="mx-auto max-w-[760px] py-6">
      <ComposeForm
        tenantName={context.active.name}
        templates={templates}
        accounts={accounts.map((a) => ({
          id: a.id,
          username: a.username,
          status: a.status,
        }))}
        copyAvailable={copyGenerationAvailable()}
        photoAvailable={photoGenerationAvailable()}
      />
    </div>
  );
}
