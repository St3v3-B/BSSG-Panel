import type { WsClientMessage, WsServerMessage } from "@panel/api";

export type { WsClientMessage, WsServerMessage };

/** Het deel van de browser-WebSocket dat de console gebruikt (ook geïmplementeerd door MockSocket). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const SOCKET_OPEN = 1;

/** Sluitcodes uit openapi.yaml. */
export const CLOSE_TOKEN_INVALID = 4001;
export const CLOSE_NO_CONSOLE_READ = 4003;
export const CLOSE_UNKNOWN_SERVER = 4004;
export const CLOSE_AUTH_TIMEOUT = 4008;

export type ConnState =
  | "idle"
  | "connecting" // token ophalen + socket openen
  | "authenticating" // socket open, auth verstuurd
  | "connected" // auth_success ontvangen
  | "reconnecting" // wacht op de volgende poging (backoff)
  | "denied" // 4003/4004 of geen recht: niet opnieuw proberen
  | "closed"; // door ons gestopt
