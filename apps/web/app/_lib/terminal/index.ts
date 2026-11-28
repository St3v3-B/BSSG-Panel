import { isMockTransport } from "@/app/_lib/console";
import { MockTerminalSocket } from "./mock-socket";
import type { TerminalSocket, TerminalSocketFactory } from "./session";

export * from "./session";
export { MockTerminalSocket } from "./mock-socket";

/** Echte WebSocket, of de mock in mock-modus. */
export const terminalSocketFactory: TerminalSocketFactory = (url) => (isMockTransport(url) ? new MockTerminalSocket(url) : (new WebSocket(url) as unknown as TerminalSocket));
