/** Image-updates: remote-handlers (daemon → panel) en de admin-queries. */
import type { AdminImageRow } from "@panel/api";
import { asc, eq } from "drizzle-orm";
import { logActivity } from "./activity";
import { call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { notify } from "./notify";
import { fetchServers, imageInfo } from "./servers-data";
import { getImageUpdateSettings } from "./settings";

export const IMAGE_TIMEZONE = "Europe/Amsterdam";

export async function remoteImageSettings() {
  const s = await getImageUpdateSettings();
  return { default_policy: s.defaultPolicy, window_start: s.windowStart, window_end: s.windowEnd, timezone: IMAGE_TIMEZONE };
}

export interface ReportedImage {
  uuid: string;
  update_available: boolean;
  reinstall_required: boolean;
  checked_at: string;
}

/** Slaat de uitkomst van een controle op (de aanroeper filtert op de servers van de node). */
export async function storeImageReport(items: ReportedImage[]): Promise<void> {
  const db = getDb();
  for (const it of items) {
    const [before] = await db.select({ id: schema.servers.id, name: schema.servers.name, available: schema.servers.imageUpdateAvailable }).from(schema.servers).where(eq(schema.servers.uuid, it.uuid));
    await db
      .update(schema.servers)
      .set({ imageUpdateAvailable: it.update_available, imageReinstallRequired: it.update_available && it.reinstall_required, imageCheckedAt: new Date(it.checked_at) })
      .where(eq(schema.servers.uuid, it.uuid));
    // Alleen de overgang naar "beschikbaar" melden (admins, volgens hun voorkeuren en de admin-webhook).
    if (before && !before.available && it.update_available) {
      await notify({ kind: "image_update", reinstallRequired: it.reinstall_required }, { server: { uuid: it.uuid, name: before.name }, hooks: [], admin: true, users: [] });
    }
  }
}

export async function adminImageRows(): Promise<AdminImageRow[]> {
  const rows = await fetchServers(undefined);
  return rows.map((b) => ({
    uuid: b.server.uuid,
    name: b.server.name,
    type: b.server.type,
    status: b.server.status,
    templateName: b.template.name,
    nodeName: b.node.name,
    image: b.template.image,
    imageUpdate: imageInfo(b),
  }));
}

/** Vraagt elke node nu te controleren (best effort per node). */
export async function checkAllNodes(): Promise<void> {
  const nodes = await getDb().select().from(schema.nodes).orderBy(asc(schema.nodes.id));
  await Promise.allSettled(nodes.map((n) => call(() => daemonFor(n).checkImages())));
}

export async function logImageUpdate(serverId: number, r: { successful: boolean; mode: "auto" | "manual"; from_image_id?: string | null; to_image_id?: string | null; error?: string | null }) {
  await logActivity({
    action: r.successful ? `server.image.update.${r.mode}` : "server.image.update.failed",
    serverId,
    metadata: { mode: r.mode, from: r.from_image_id?.slice(0, 19) ?? null, to: r.to_image_id?.slice(0, 19) ?? null, ...(r.successful ? {} : { error: r.error?.slice(0, 2000) ?? null }) },
  });
}
