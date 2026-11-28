// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Node } from "@panel/api";
import { NodeNpm } from "@/app/_components/admin/node-npm";
import { NodesAdmin } from "@/app/_components/admin/nodes";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const node1: Node = { id: 1, name: "node1", fqdn: "node1.test", daemonPort: 8080, sftpPort: 2022, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null, diskQuotaMode: "soft", isLocal: true, supportsDomains: true, publicPort: 443, publicIp: null, joinState: null, httpRelayNodeId: null, httpMode: "direct" };

describe("admin: node achter Nginx Proxy Manager", () => {
  it("relay actief: alleen de uitleg, geen formulier", async () => {
    renderWithTrpc(<NodeNpm node={{ ...node1, isLocal: false, httpRelayNodeId: 3, httpMode: "relay" }} />, admin);
    expect(await screen.findByText(/Switch the relay off first/)).toBeTruthy();
    expect(screen.queryByTestId("npm-form")).toBeNull();
  });

  it("aanzetten, Test verbinding (goed en fout), opslaan zonder geheimen terug, status en omzetcommando", async () => {
    const { bodies } = renderWithTrpc(<NodeNpm node={node1} />, admin);
    fireEvent.click(await screen.findByTestId("npm-enable"));
    expect((screen.getByLabelText("NPM admin URL") as HTMLInputElement).value).toBe("http://127.0.0.1:81");
    fireEvent.change(screen.getByLabelText("NPM user (email)"), { target: { value: "npm@panel.test" } });
    fireEvent.change(screen.getByLabelText("NPM password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("npm-test"));
    expect((await screen.findByTestId("npm-test-result")).textContent).toMatch(/Login failed: NPM answered 401/);
    fireEvent.change(screen.getByLabelText("NPM password"), { target: { value: "geheim-wachtwoord" } });
    fireEvent.click(screen.getByTestId("npm-test"));
    await waitFor(() => expect(screen.getByTestId("npm-test-result").textContent).toMatch(/Logged in to NPM 2\.17\.1: 4 proxy host\(s\)/));
    expect(input(bodies, "admin.nodes.testNpm").at(-1)).toEqual({ id: 1, url: "http://127.0.0.1:81", email: "npm@panel.test", password: "geheim-wachtwoord" });
    // Cloudflare: tokenveld verschijnt.
    fireEvent.change(screen.getByLabelText("SSL"), { target: { value: "cloudflare" } });
    fireEvent.change(screen.getByLabelText("Cloudflare API token"), { target: { value: "cf-token" } });
    fireEvent.click(screen.getByTestId("npm-save"));
    await screen.findByText(/Saved\. The node picks up the settings right away/);
    expect(input(bodies, "admin.nodes.setNpm")[0]).toEqual({
      id: 1,
      settings: { url: "http://127.0.0.1:81", email: "npm@panel.test", password: "geheim-wachtwoord", forwardHost: null, forwardPort: null, ssl: "cloudflare", cloudflareToken: "cf-token", forceSsl: true },
    });
    // Na opslaan: status van de node, wachtwoord niet terug in het formulier.
    expect((await screen.findByTestId("npm-state")).textContent).toBe("Connected");
    expect(screen.getByTestId("npm-report").textContent).toMatch(/NPM 2\.17\.1: 4 proxy host\(s\), 2 managed by the panel/);
    expect((screen.getByLabelText("NPM password") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText(/Saved \(encrypted\)\. Leave empty to keep it\./).length).toBeGreaterThan(0);
    expect(screen.getByTestId("npm-mode-command").textContent).toMatch(/install\.sh --http-mode npm/);
    // Opnieuw opslaan zonder wachtwoord: geen password-veld in de invoer.
    fireEvent.click(screen.getByTestId("npm-save"));
    await waitFor(() => expect(input(bodies, "admin.nodes.setNpm")).toHaveLength(2));
    expect(input(bodies, "admin.nodes.setNpm")[1]).not.toHaveProperty("settings.password");
    // Uitzetten.
    fireEvent.click(screen.getByTestId("npm-disable"));
    await waitFor(() => expect(input(bodies, "admin.nodes.setNpm").at(-1)).toEqual({ id: 1, settings: null }));
    expect(await screen.findByTestId("npm-enable")).toBeTruthy();
  });

  it("Nederlands", async () => {
    renderWithTrpc(<NodeNpm node={node1} />, { ...admin, locale: "nl" });
    fireEvent.click(await screen.findByTestId("npm-enable"));
    expect(screen.getByTestId("npm-test").textContent).toMatch(/Test verbinding/);
    expect(screen.getByLabelText("NPM-wachtwoord")).toBeTruthy();
    expect(screen.getByText(/Websockets en HTTP\/2 staan altijd aan/)).toBeTruthy();
  });

  it("badge op de nodekaart", async () => {
    renderWithTrpc(<NodesAdmin />, {
      ...admin,
      patch: (m: any) => {
        const list = m.admin.nodes.list;
        m.admin.nodes.list = async (o: never) => (await list(o)).map((n: Node) => (n.id === 1 ? { ...n, httpMode: "npm" } : n));
      },
    });
    await waitFor(() => expect(screen.getByTestId("node-npm-badge").textContent).toBe("Behind NPM"));
  });
});
