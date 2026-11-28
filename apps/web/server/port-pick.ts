/**
 * Vrije allocations kiezen voor een nieuwe server, rekening houdend met de `ports` van de template
 * (extra poorten liefst op primair + offset, zie templates/SCHEMA.md).
 */
import { pickTemplateAllocations, type TemplatePort } from "@panel/api";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "./db";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AllocRow = typeof schema.allocations.$inferSelect;

const freeOn = (nodeId: number) => and(eq(schema.allocations.nodeId, nodeId), isNull(schema.allocations.serverId));

/**
 * Kiest en vergrendelt `wanted` vrije allocations op de node (primair eerst). Zonder extra template-poorten:
 * de laagste vrije poorten (zoals voorheen). Geeft minder dan `wanted` rijen terug als er te weinig vrij zijn.
 */
export async function pickFreeAllocations(tx: Tx, nodeId: number, ports: readonly TemplatePort[], wanted: number): Promise<AllocRow[]> {
  if (wanted <= 0) return [];
  const lowest = () =>
    tx.select().from(schema.allocations).where(freeOn(nodeId)).orderBy(asc(schema.allocations.port), asc(schema.allocations.id)).limit(wanted).for("update", { skipLocked: true });
  if (ports.length <= 1 || wanted === 1) return lowest();
  const free = await tx.select().from(schema.allocations).where(freeOn(nodeId)).orderBy(asc(schema.allocations.port), asc(schema.allocations.id));
  const picked = pickTemplateAllocations(free, ports, wanted);
  if (!picked) return lowest();
  const ids = picked.map((a) => a.id);
  const locked = await tx.select().from(schema.allocations).where(and(freeOn(nodeId), inArray(schema.allocations.id, ids))).for("update", { skipLocked: true });
  if (locked.length !== ids.length) return lowest(); // tegelijk door een ander gepakt: gewoon de laagste vrije
  const byId = new Map(locked.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)!);
}
