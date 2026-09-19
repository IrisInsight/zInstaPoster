"use client";

import { useState, useTransition } from "react";
import { retryPublishAction } from "@/app/actions/posts";

export function RetryButton({ postId }: { postId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await retryPublishAction(postId);
            setError(result.ok ? null : (result.error ?? "Retry failed."));
          })
        }
        className="rounded-md border border-[var(--color-danger)] px-2 py-1 text-[11.5px] font-medium text-[var(--color-danger)] hover:bg-white disabled:opacity-60"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error && (
        <span className="max-w-[220px] text-right text-[10.5px] text-[var(--color-danger)]">
          {error}
        </span>
      )}
    </div>
  );
}
