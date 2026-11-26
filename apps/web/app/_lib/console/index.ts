import { MockSocket, type MockSocketOptions } from "./mock-socket";
import type { SocketFactory, SocketLike } from "./types";

export * from "./types";
export { ConsoleConnection, backoffDelay, DEFAULT_BACKOFF, type ConsoleToken, type ConsoleConnectionOptions } from "./connection";
export { CommandHistory } from "./history";
export { MockSocket } from "./mock-socket";

/** Mock-transport alleen als het panel in mock-modus draait (NEXT_PUBLIC_PANEL_MOCK=1). */
export function isMockTransport(_socketUrl: string, env: string | undefined = process.env.NEXT_PUBLIC_PANEL_MOCK): boolean {
  return env === "1";
}

/** Kiest per URL de echte WebSocket of de mock-socket. */
export function socketFactory(mock: MockSocketOptions): SocketFactory {
  return (url) => (isMockTransport(url) ? new MockSocket(url, mock) : (new WebSocket(url) as unknown as SocketLike));
}
