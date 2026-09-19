import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant-context";
import { listQueue } from "@/lib/posts/service";
import { POST_STATUSES, type PostStatus } from "@/lib/db/schema";
import { StatusPill } from "@/components/status-pill";
import { SlideThumb } from "@/components/slide-thumb";
import { formatInZone, relativeTime, zoneAbbreviation } from "@/lib/time";
import { RetryButton } from "@/components/retry-button";

export const dynamic = "force-dynamic";

const FILTERS: (PostStatus | "all")[] = ["all", ...POST_STATUSES];

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; tenant?: string }>;
}) {
  const user = await requireUser();
  const context = await getTenantContext(user);
  const params = await searchParams;
  const status = (params.status ?? "all") as PostStatus | "all";
  const tenantScope = params.tenant ?? context?.active.id ?? "all";

  if (!context) {
    return (
      <EmptyState
        title="No tenant is assigned to this account"
        body="An operator has to add you to a tenant before anything shows up here."
      />
    );
  }

  const rows = await listQueue({
    tenantIds: user.tenantIds,
    status,
    tenantId: tenantScope,
  });

  const failed = rows.filter((r) => r.post.status === "failed");
  const rest = rows.filter((r) => r.post.status !== "failed");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Queue</h1>
          <p className="text-[12.5px] text-[var(--color-muted)]">
            {rows.length} post{rows.length === 1 ? "" : "s"} · {context.active.name} ·{" "}
            {zoneAbbreviation(new Date(), context.config.timezone)}
          </p>
        </div>
        <FilterBar active={status} />
      </div>

      {failed.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-danger)]">
            Did not publish
          </h2>
          <div className="overflow-hidden rounded-lg border border-[#efc0b8]">
            {failed.map((row) => (
              <PostRow
                key={row.post.id}
                row={row}
                timezone={context.config.timezone}
                loud
              />
            ))}
          </div>
        </section>
      )}

      {rest.length === 0 && failed.length === 0 ? (
        <EmptyState
          title={status === "all" ? "Nothing in the queue yet" : `No ${status.replace("_", " ")} posts`}
          body={
            status === "all"
              ? "Write a prompt and the pipeline will draft a carousel for review."
              : "Change the filter to see the rest of the queue."
          }
          action
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
          {rest.map((row) => (
            <PostRow
              key={row.post.id}
              row={row}
              timezone={context.config.timezone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterBar({ active }: { active: PostStatus | "all" }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {FILTERS.map((filter) => (
        <Link
          key={filter}
          href={filter === "all" ? "/" : `/?status=${filter}`}
          className={`rounded-md border px-2 py-1 text-[11.5px] ${
            active === filter
              ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white"
              : "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
          }`}
        >
          {filter === "all" ? "All" : filter.replace(/_/g, " ")}
        </Link>
      ))}
    </div>
  );
}

type Row = Awaited<ReturnType<typeof listQueue>>[number];

function PostRow({
  row,
  timezone,
  loud,
}: {
  row: Row;
  timezone: string;
  loud?: boolean;
}) {
  const { post, slides, tenant } = row;
  const headline =
    (slides[0]?.copy as { headline?: string })?.headline ?? post.title;
  const href =
    post.status === "published" || post.status === "failed"
      ? `/posts/${post.id}`
      : `/posts/${post.id}/review`;

  return (
    <div
      className={`group flex items-start gap-3 border-b border-[var(--color-line)] px-3 py-2.5 last:border-b-0 ${
        loud ? "bg-[var(--color-danger-soft)]" : "hover:bg-[var(--color-canvas)]"
      }`}
    >
      <Link href={href} className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex shrink-0 gap-1">
          {slides.slice(0, 4).map((slide) => (
            <SlideThumb
              key={slide.id}
              url={slide.renderedUrl}
              position={slide.position}
              className="w-11"
            />
          ))}
          {slides.length === 0 && (
            <div className="flex h-[55px] w-11 items-center justify-center rounded-[3px] border border-dashed border-[var(--color-line-strong)] text-[10px] text-[var(--color-faint)]">
              —
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={post.status as PostStatus} />
            <span className="rounded border border-[var(--color-line)] px-1.5 py-[1px] text-[10.5px] text-[var(--color-muted)]">
              {tenant?.name ?? "—"}
            </span>
            {post.status === "scheduled" && post.scheduledFor && (
              <span className="tabular text-[11.5px] text-[var(--color-info)]">
                {formatInZone(post.scheduledFor, timezone)} ·{" "}
                {relativeTime(post.scheduledFor)}
              </span>
            )}
            {post.status === "published" && post.publishedAt && (
              <span className="tabular text-[11.5px] text-[var(--color-muted)]">
                {formatInZone(post.publishedAt, timezone)}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[14px] font-medium leading-snug">
            {headline}
          </p>
          {post.status === "failed" && post.failureReason && (
            <p className="mt-1 line-clamp-2 font-mono text-[11.5px] leading-snug text-[var(--color-danger)]">
              {post.failureReason}
            </p>
          )}
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-2 pt-1">
        {post.status === "failed" && <RetryButton postId={post.id} />}
        <span className="tabular text-[11.5px] text-[var(--color-faint)]">
          {relativeTime(post.createdAt)}
        </span>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-6 py-14 text-center">
      <p className="text-[14px] font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-[420px] text-[13px] text-[var(--color-muted)]">
        {body}
      </p>
      {action && (
        <Link
          href="/compose"
          className="mt-4 inline-block rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-[13px] font-medium text-white"
        >
          New post
        </Link>
      )}
    </div>
  );
}
