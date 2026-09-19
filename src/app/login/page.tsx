"use client";

import { useActionState } from "react";
import { signInAction } from "@/app/actions/session";
import { Wordmark } from "@/components/logo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signInAction, {});

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <Wordmark className="mb-8 h-14" />
        <form
          action={action}
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <h1 className="text-[15px] font-semibold">Sign in</h1>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            Internal tool. Accounts are created by the operator.
          </p>

          <label className="mt-4 block text-[12px] font-medium text-[var(--color-muted)]">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              className="mt-1 w-full rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[14px] text-[var(--color-ink)]"
            />
          </label>

          <label className="mt-3 block text-[12px] font-medium text-[var(--color-muted)]">
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[14px] text-[var(--color-ink)]"
            />
          </label>

          {state?.error && (
            <p
              role="alert"
              className="mt-3 rounded-md border border-[#efc0b8] bg-[var(--color-danger-soft)] px-2.5 py-2 text-[12.5px] text-[var(--color-danger)]"
            >
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="mt-4 w-full rounded-md bg-[var(--color-ink)] px-3 py-2 text-[13.5px] font-medium text-white disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
