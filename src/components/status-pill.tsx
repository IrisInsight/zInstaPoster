import type { PostStatus } from "@/lib/db/schema";

const STYLES: Record<PostStatus, { label: string; className: string }> = {
  draft: { label: "draft", className: "bg-[var(--color-canvas)] text-[var(--color-muted)] border-[var(--color-line-strong)]" },
  pending_approval: { label: "pending approval", className: "bg-[var(--color-warn-soft)] text-[var(--color-warn)] border-[#e8d6a8]" },
  approved: { label: "approved", className: "bg-[var(--color-ok-soft)] text-[var(--color-ok)] border-[#bcd8c6]" },
  rejected: { label: "rejected", className: "bg-[var(--color-canvas)] text-[var(--color-muted)] border-[var(--color-line-strong)] line-through decoration-1" },
  scheduled: { label: "scheduled", className: "bg-[var(--color-info-soft)] text-[var(--color-info)] border-[#c0d3e2]" },
  publishing: { label: "publishing", className: "bg-[var(--color-info-soft)] text-[var(--color-info)] border-[#c0d3e2]" },
  published: { label: "published", className: "bg-[#eef3ec] text-[#3d5c3d] border-[#c9d8c5]" },
  failed: { label: "failed", className: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[#efc0b8]" },
};

export function StatusPill({
  status,
  size = "sm",
}: {
  status: PostStatus;
  size?: "sm" | "md";
}) {
  const style = STYLES[status] ?? STYLES.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] font-medium tracking-wide uppercase ${
        size === "sm" ? "text-[10.5px]" : "text-[11.5px] px-2.5 py-[3px]"
      } ${style.className}`}
    >
      {(status === "publishing" || status === "scheduled") && (
        <span className="size-1.5 rounded-full bg-current pulse" />
      )}
      {style.label}
    </span>
  );
}
