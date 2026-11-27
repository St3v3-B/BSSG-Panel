/**
 * Types voor de daemon-API, gegenereerd uit openapi.yaml en panel-remote.yaml
 * (`pnpm --filter @panel/api gen`). De test controleert dat de .gen-bestanden actueel zijn.
 */
import type { components as D, paths as DP } from "./daemon-types.gen";
import type { components as R, paths as RP } from "./panel-remote-types.gen";

export type DaemonPaths = DP;
export type DaemonSchemas = D["schemas"];
export type RemotePaths = RP;
export type RemoteSchemas = R["schemas"];

export type DaemonServerSpec = D["schemas"]["ServerSpec"];
export type DaemonServerState = D["schemas"]["ServerState"];
export type DaemonStats = D["schemas"]["Stats"];
export type DaemonSystemInfo = D["schemas"]["SystemInfo"];
export type DaemonRoute = D["schemas"]["Route"];
export type DaemonRouteWithStatus = D["schemas"]["RouteWithStatus"];
export type DaemonFileEntry = D["schemas"]["FileEntry"];
export type DaemonSearchResult = D["schemas"]["SearchResult"];
export type DaemonChmodRequest = D["schemas"]["ChmodRequest"];
export type WsClientMessage = D["schemas"]["WsClientMessage"];
export type WsServerMessage = D["schemas"]["WsServerMessage"];

/** Claims in de browser-JWT (zie openapi.yaml, Authenticatie). */
export interface BrowserJwtClaims {
  iss: string;
  aud: string;
  sub: string;
  server_uuid: string;
  permissions: string[];
  /** Alleen bij download: het pad uit de URL moet hieraan gelijk zijn. */
  path?: string;
  /** Alleen bij upload: de map uit de URL moet hieraan gelijk zijn. */
  directory?: string;
  /** Alleen bij een archief-download (`/files/archive`): wat er ingepakt wordt. */
  archive?: { root: string; paths: string[]; format: "zip" | "tar.gz" };
  jti: string;
  iat: number;
  exp: number;
}
