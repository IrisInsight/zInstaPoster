import { cookies } from "next/headers";
import type { SessionUser } from "@/lib/auth";
import { tenantsForUser } from "@/lib/auth";
import { tenantConfigFromRow, type TenantConfig } from "@/lib/tenants";
import type { Tenant } from "@/lib/db";

const COOKIE = "zip_tenant";

export interface TenantContext {
  tenants: Tenant[];
  active: Tenant;
  config: TenantConfig;
  /** A single-tenant user never sees the switcher. */
  showSwitcher: boolean;
}

export async function getTenantContext(
  user: SessionUser,
): Promise<TenantContext | null> {
  const tenants = await tenantsForUser(user);
  if (tenants.length === 0) return null;

  const store = await cookies();
  const preferred = store.get(COOKIE)?.value;
  const active =
    tenants.find((t) => t.id === preferred || t.slug === preferred) ?? tenants[0];

  return {
    tenants,
    active,
    config: tenantConfigFromRow(active),
    showSwitcher: tenants.length > 1,
  };
}

export async function setActiveTenant(tenantId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, tenantId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
