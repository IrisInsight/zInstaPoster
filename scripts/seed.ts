/**
 * Seeds tenants from tenants/*.json, a starting user, and the five shipped
 * Precision Vitality carousels as real posts so the queue is not empty on a
 * fresh install.
 *
 *   npm run db:seed
 *
 * The logic is in src/lib/seed.ts because the deploy bootstrap runs it too.
 */
import { closeDb } from "@/lib/db";
import { seedDatabase } from "@/lib/seed";

seedDatabase({ log: (line) => console.log(line) })
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
