/**
 * Runs once when the server starts.
 *
 * The local scheduler keeps its timers in process memory, so a restart would
 * otherwise drop them. QStash-backed schedules survive on their own and this
 * is a no-op for them.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { rehydrateLocalSchedule, schedulerDriver } = await import(
      "@/lib/scheduler"
    );
    if (schedulerDriver() !== "local") return;
    const restored = await rehydrateLocalSchedule();
    if (restored > 0) {
      console.log(`Restored ${restored} scheduled post(s) into the local scheduler.`);
    }
  } catch (error) {
    console.error("Could not restore the local schedule", error);
  }
}
