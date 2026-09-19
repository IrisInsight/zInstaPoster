"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { signIn, signOut } from "@/lib/auth";
import { setActiveTenant } from "@/lib/tenant-context";

export async function signInAction(
  _state: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await signIn(email, password);
  if (!user) return { error: "That email and password do not match." };
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
