/** Draait alle migraties uit ./migrations tegen DATABASE_URL. Gebruik: `pnpm --filter @panel/db migrate`. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is missing");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "migrations") });
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(
    () => console.log("migrations done"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
