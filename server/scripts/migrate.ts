/**
 * Database migration script.
 * Uses Drizzle Kit to run migrations from the /migrations folder.
 * 
 * Usage: npx tsx server/scripts/migrate.ts
 * Or: npm run db:migrate (if script added to package.json)
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function runMigrations() {
  console.log("🔄 Running database migrations...");
  
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL environment variable is not set");
    process.exit(1);
  }
  
  try {
    // Use drizzle-kit push to sync schema with database
    // This is the recommended approach for Drizzle ORM
    const { stdout, stderr } = await execAsync("npx drizzle-kit push");
    
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    
    console.log("✅ Migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

runMigrations();
