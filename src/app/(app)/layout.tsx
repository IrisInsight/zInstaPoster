import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant-context";
import { Mark } from "@/components/logo";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { NavLink } from "@/components/nav-link";
import { signOutAction } from "@/app/actions/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const context = await getTenantContext(user);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
        <div className="mx-auto flex h-13 max-w-[1560px] items-center gap-4 px-4 py-2">
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <Mark className="size-8" />
            <span className="text-[15px] font-semibold tracking-tight">
              <span className="text-[var(--color-flame)]">z</span>InstaPoster
            </span>
          </Link>

          <nav className="flex items-center gap-0.5">
            <NavLink href="/">Queue</NavLink>
            <NavLink href="/accounts">Accounts</NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {context?.showSwitcher && (
              <TenantSwitcher
                tenants={context.tenants.map((t) => ({ id: t.id, name: t.name }))}
                activeId={context.active.id}
              />
            )}
            <Link
              href="/compose"
              className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-black"
            >
              New post
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                title={`Signed in as ${user.name}`}
                className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1560px] px-4 py-5">{children}</main>
    </div>
  );
}
