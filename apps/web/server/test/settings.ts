import { getDb, schema } from "../db";

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb().insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}
