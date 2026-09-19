"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AccessDenied, signInWithCode, signOut } from "@/lib/auth";
import { setActiveTenant } from "@/lib/tenant-context";

export async function signInAction(
  _state: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const code = String(formData.get("code") ?? "");
  try {
    const user = await signInWithCode(code);
    if (!user) return { error: "That access code is not right." };
  } catch (error) {
    if (error instanceof AccessDenied) return { error: error.message };
    // A misconfigured deployment should say so on the screen rather than
    // showing an error page that looks like a wrong code.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("DATABASE_URL")) return { error: message };
    throw error;
  }
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

export async function switchTenantAction(tenantId: string): Promise<void> {
  await setActiveTenant(tenantId);
  revalidatePath("/", "layout");
}
