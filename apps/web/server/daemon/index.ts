/** Daemon-client per node, plus vertaling van daemonfouten naar tRPC-fouten. */
import { TRPCError } from "@trpc/server";
import { getEnv } from "../env";
import { decrypt } from "../lib/crypto";
import { DaemonClient, DaemonHttpError, DaemonUnreachableError } from "./client";

export { DaemonClient, DaemonHttpError, DaemonUnreachableError } from "./client";

export interface NodeRef {
  id: number;
  fqdn: string;
  isLocal: boolean;
  daemonPort?: number;
  publicPort?: number;
  tokenEnc?: string | null;
}

/** Host (met poort als die niet 443 is) waarop https://<fqdn> van de node bereikbaar is: console, uploads, daemon. */
export function nodeHost(node: Pick<NodeRef, "fqdn" | "publicPort">): string {
  return node.publicPort && node.publicPort !== 443 ? `${node.fqdn}:${node.publicPort}` : node.fqdn;
}

/** Alleen tests: basis-URL per node-id (een nep-daemon in plaats van https://<fqdn>). */
export const daemonUrlOverrides = new Map<number, string>();

/** Lokale node: DAEMON_URL + NODE_TOKEN. Andere nodes: https://<fqdn> met het token uit nodes.token_enc. */
export function daemonFor(node: NodeRef): DaemonClient {
  const env = getEnv();
  if (node.isLocal) return new DaemonClient({ nodeId: node.id, baseUrl: env.DAEMON_URL, token: env.NODE_TOKEN });
  if (node.tokenEnc) return new DaemonClient({ nodeId: node.id, baseUrl: daemonUrlOverrides.get(node.id) ?? `https://${nodeHost(node)}`, token: decrypt(node.tokenEnc) });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "NODE_TOKEN_UNAVAILABLE" });
}

/** Daemonfout → TRPCError met een herkenbare message. */
export function toTrpcError(e: unknown): unknown {
  if (e instanceof DaemonUnreachableError) return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DAEMON_UNREACHABLE", cause: e });
  if (e instanceof DaemonHttpError) {
    const code =
      e.status === 404 ? "NOT_FOUND"
      : e.status === 409 ? "CONFLICT"
      : e.status === 400 ? "BAD_REQUEST"
      : e.status === 507 ? "PRECONDITION_FAILED"
      : e.status === 413 ? "PAYLOAD_TOO_LARGE"
      : "INTERNAL_SERVER_ERROR";
    if (e.status === 507 || e.code === "disk_exceeded") return new TRPCError({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED", cause: e });
    return new TRPCError({ code, message: `DAEMON_${e.code.toUpperCase()}: ${e.message}`, cause: e });
  }
  return e;
}

/** Voert een daemonaanroep uit en vertaalt fouten. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toTrpcError(e);
  }
}
