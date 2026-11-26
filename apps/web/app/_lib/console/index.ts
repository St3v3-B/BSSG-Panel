import { MockSocket, type MockSocketOptions } from "./mock-socket";
import type { SocketFactory, SocketLike } from "./types";

export * from "./types";
export { ConsoleConnection, backoffDelay, DEFAULT_BACKOFF, type ConsoleToken, type ConsoleConnectionOptions } from "./connection";
export { CommandHistory } from "./history";
export { MockSocket } from "./mock-socket";

/** Mock-transport als het panel in mock-modus draait of de socket-host op .test eindigt. */
export function isMockTransport(socketUrl: string, env: string | undefined = process.env.NEXT_PUBLIC_PANEL_MOCK): boolean {
  if (env === "1") return true;
  try {
    return new URL(socketUrl).hostname.endsWith(".test");
  } catch {
    return false;
  }
}

/** Kiest per URL de echte WebSocket of de mock-socket. */
export function socketFactory(mock: MockSocketOptions): SocketFactory {
  return (url) => (isMockTransport(url) ? new MockSocket(url, mock) : (new WebSocket(url) as unknown as SocketLike));
}
