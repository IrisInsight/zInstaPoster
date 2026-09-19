"use client";

import { useTransition } from "react";
import { switchTenantAction } from "@/app/actions/session";

export function TenantSwitcher({
  tenants,
  activeId,
}: {
  tenants: { id: string; name: string }[];
  activeId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <select
      aria-label="Tenant"
      defaultValue={activeId}
      disabled={pending}
      onChange={(event) => {
        const value = event.target.value;
        startTransition(() => void switchTenantAction(value));
      }}
      className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
    >
      {tenants.map((tenant) => (
        <option key={tenant.id} value={tenant.id}>
          {tenant.name}
        </option>
      ))}
    </select>
  );
}
