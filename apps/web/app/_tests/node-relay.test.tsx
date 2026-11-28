// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Node } from "@panel/api";
import { NodeHttpRelay } from "@/app/_components/admin/node-relay";
import { NodesAdmin } from "@/app/_components/admin/nodes";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const node2: Node = { id: 2, name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2022, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, diskQuotaMode: "soft", isLocal: false, supportsDomains: true, publicPort: 443, publicIp: "203.0.113.20", joinState: "ready", httpRelayNodeId: null };
const withNode2 = (m: any) => {
  const list = m.admin.nodes.list;
  m.admin.nodes.list = async (o: never) => [...(await list(o)), node2];
  // De mock kent node2 niet in zijn eigen lijst: zet hem erin via create-achtig gedrag.
  const status = m.admin.nodes.relayStatus;
  m.admin.nodes.relayStatus = async (o: { input: { id: number } }) => {
    if (o.input.id !== 2) return status(o);
    return {
      relayNodeId: node2.httpRelayNodeId,
      httpIp: node2.httpRelayNodeId ? "198.51.100.1" : "203.0.113.20",
      tunnel: node2.httpRelayNodeId ? { connected: false, latencyMs: null, lastError: "relay: edge refused the tunnel: HTTP 401", lastErrorAt: new Date(), connectedAt: null, reconnects: 3, httpMode: "direct", reportedAt: new Date() } : null,
      edge: node2.httpRelayNodeId ? { connected: false, latencyMs: null, lastError: null, hosts: ["node2.test"] } : null,
      dns: [{ name: "node2.test", type: "A", value: node2.httpRelayNodeId ? "198.51.100.1" : "203.0.113.20", managed: true, applied: null, error: null, ok: false }],
      candidates: [{ id: 1, name: "node1", fqdn: "node1.test" }],
      clients: [],
      modeCommand: `curl -fsSL https://panel.test/join | sudo bash -s -- --http-mode ${node2.httpRelayNodeId ? "relay" : "direct"}`,
    };
  };
  m.admin.nodes.setHttpRelay = async (o: { input: { id: number; relayNodeId: number | null } }) => {
    node2.httpRelayNodeId = o.input.relayNodeId;
    return { node: node2, dns: [{ name: "node2.test", type: "A", value: "198.51.100.1", managed: true, applied: true, error: null, ok: null }] };
  };
};

describe("admin: HTTP(S)-relay per node", () => {
  it("keuze, waarschuwing over DNS, toepassen en het commando voor de node", async () => {
    node2.httpRelayNodeId = null;
    const { bodies } = renderWithTrpc(<NodeHttpRelay node={node2} />, { ...admin, patch: withNode2 });
    const sel = (await screen.findByTestId("relay-select")) as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["Own ports 80/443", "Node node1 (node1.test)"]);
    expect(screen.queryByTestId("relay-warning")).toBeNull();
    fireEvent.change(sel, { target: { value: "1" } });
    const warn = screen.getByTestId("relay-warning");
    expect(warn.textContent).toMatch(/DNS has to change/);
    expect(warn.textContent).toMatch(/point to node1\.test/);
    expect(warn.textContent).toMatch(/Game ports and SFTP always go directly/);
    expect(screen.getByTestId("relay-mode-command").textContent).toContain("--http-mode relay");
    fireEvent.click(screen.getByTestId("relay-apply"));
    await screen.findByText(/Saved\. The nodes are told right away/);
    expect(input(bodies, "admin.nodes.setHttpRelay")[0]).toEqual({ id: 2, relayNodeId: 1 });
    // Na het toepassen: tunnelstatus, de fout van de node en het omzetcommando (de node draait nog "direct").
    const tunnel = await screen.findByTestId("relay-tunnel");
    await waitFor(() => expect(tunnel.textContent).toMatch(/Not connected/));
    expect(tunnel.textContent).toMatch(/HTTP 401/);
    expect(tunnel.textContent).toMatch(/3 reconnect/);
    expect(screen.getByTestId("relay-mode-command").textContent).toMatch(/still runs Caddy.*--http-mode relay/);
    expect(within(screen.getByTestId("relay-dns")).getByText(/node2\.test A 198\.51\.100\.1/)).toBeTruthy();
  });

  it("lokale node: geen keuze", async () => {
    renderWithTrpc(<NodeHttpRelay node={{ ...node2, id: 1, name: "node1", fqdn: "node1.test", isLocal: true }} />, admin);
    expect(await screen.findByText(/always uses its own ports 80\/443/)).toBeTruthy();
    expect(screen.queryByTestId("relay-select")).toBeNull();
  });

  it("node toevoegen via een relay-node", async () => {
    node2.httpRelayNodeId = null;
    const { bodies } = renderWithTrpc(<NodesAdmin />, admin);
    await screen.findAllByTestId("node-card");
    fireEvent.click(screen.getByRole("button", { name: /Add node/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "node3" } });
    fireEvent.change(screen.getByTestId("node-http-relay-select"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add node$/ }));
    await screen.findByTestId("join-command");
    expect(input(bodies, "admin.nodes.createJoin")[0]).toMatchObject({ name: "node3", supportsDomains: true, httpRelayNodeId: 1 });
    await waitFor(() => expect(screen.getAllByTestId("node-relay-badge")[0]!.textContent).toBe("HTTP(S) via node1"));
  });
});
