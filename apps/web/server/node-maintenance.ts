/**
 * Onderhoudsmodus van een node: kleine helpers zonder zware imports (servers-data, admin, billing gebruiken ze).
 * Zie routers/maintenance.ts voor aanzetten, evacueren en meldingen.
 */
import type { NodeMaintenance } from "@panel/api";
import { TRPCError } from "@trpc/server";

type Stored = { since: string; message: string | null; plannedStart: string | null; plannedEnd: string | null; by?: number | null } | null | undefined;

const date = (s: string | null) => (s ? new Date(s) : null);

/** Opgeslagen jsonb → contractvorm (null = niet in onderhoud). */
export function maintenanceOut(m: Stored): NodeMaintenance | null {
  if (!m) return null;
  return { since: new Date(m.since), message: m.message ?? null, plannedStart: date(m.plannedStart), plannedEnd: date(m.plannedEnd) };
}

/** Gooit PRECONDITION_FAILED `NODE_IN_MAINTENANCE` als er geen nieuwe servers op deze node mogen. */
export function assertNotInMaintenance(node: { name: string; maintenance?: Stored }): void {
  if (node.maintenance) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `NODE_IN_MAINTENANCE: node ${node.name} is in maintenance and does not accept new servers` });
}
