// @vitest-environment jsdom
import { TRPCError } from "@trpc/server";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityAdmin } from "@/app/_components/admin/activity";
import { AllocationsAdmin, NodesAdmin, portsValid } from "@/app/_components/admin/nodes";
import { TemplateEditor } from "@/app/_components/admin/templates";
import { UsersAdmin } from "@/app/_components/admin/users";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />,
}));

afterEach(cleanup);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const input = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("nodes", () => {
  const fill = (supports = true) => {
    fireEvent.click(screen.getByRole("button", { name: /Add node/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "node2" } });
    if (!supports) fireEvent.click(screen.getByTestId("node-supports-domains"));
    fireEvent.click(screen.getByRole("button", { name: /^Add node$/ }));
  };

  it("aanmaken toont één join-regel met code (geen token) en de voortgangsstappen", async () => {
    const { bodies } = renderWithTrpc(<NodesAdmin />, admin);
    await screen.findAllByTestId("node-card");
    fill();
    const cmd = await screen.findByTestId("join-command");
    expect(cmd.textContent).toBe("curl -fsSL https://panel.test/join | sudo bash -s -- mock-join-code");
    expect(screen.queryByTestId("node-token")).toBeNull();
    expect(input(bodies, "admin.nodes.createJoin")[0]).toMatchObject({ name: "node2", supportsDomains: true, allocationPorts: "25565-25600", daemonPort: 8080, sftpPort: 2022 });
    const steps = await screen.findByTestId("join-steps");
    expect(within(steps).getByText("Waiting for the node")).toBeTruthy();
    expect(within(steps).getByText("Certificate OK")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("node-card")).toHaveLength(2));
    // DNS: het exacte record wordt getoond zolang het niet wijst.
    expect((await screen.findByTestId("join-dns")).textContent).toContain("node2.panel.test A");
  });

  it("zonder domeinondersteuning: publieke poort wordt meegestuurd", async () => {
    const { bodies } = renderWithTrpc(<NodesAdmin />, admin);
    await screen.findAllByTestId("node-card");
    fill(false);
    await screen.findByTestId("join-command");
    expect(input(bodies, "admin.nodes.createJoin")[0]).toMatchObject({ supportsDomains: false, publicPort: 8443 });
  });

  it("NOT_IMPLEMENTED van de backend wordt netjes getoond", async () => {
    renderWithTrpc(<NodesAdmin />, {
      ...admin,
      patch: (m) => {
        (m.admin.nodes as Mutable<typeof m.admin.nodes>).createJoin = () => {
          throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "NOT_IMPLEMENTED: admin.nodes.createJoin" });
        };
      },
    });
    await screen.findAllByTestId("node-card");
    fill();
    expect((await screen.findByTestId("not-implemented")).textContent).toBe("The backend doesn't support this yet.");
  });
});

describe("allocations", () => {
  it("portsValid", () => {
    expect(portsValid("25565")).toBe(true);
    expect(portsValid("25565-25600")).toBe(true);
    expect(portsValid("25565, 25570-25575")).toBe(true);
    expect(portsValid("25600-25565")).toBe(false);
    expect(portsValid("70000")).toBe(false);
    expect(portsValid("abc")).toBe(false);
  });

  it("bereik toevoegen", async () => {
    const { bodies } = renderWithTrpc(<AllocationsAdmin nodeId={1} />, admin);
    await screen.findAllByTestId("allocation");
    fireEvent.change(screen.getByLabelText("IP address"), { target: { value: "203.0.113.10" } });
    fireEvent.change(screen.getByLabelText("Ports"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(screen.getByText(/Use ports like/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ports"), { target: { value: "25570 - 25572" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText("3 allocations added.")).toBeTruthy();
    expect(input(bodies, "admin.allocations.create")[0]).toEqual({ nodeId: 1, ip: "203.0.113.10", ports: "25570-25572" });
    await waitFor(() => expect(screen.getAllByTestId("allocation")).toHaveLength(7));
  });
});

describe("gebruikers", () => {
  it("blokkeren en 2FA resetten met bevestiging, vooraf aanmaken", async () => {
    const { bodies } = renderWithTrpc(<UsersAdmin />, admin);
    const rows = await screen.findAllByTestId("user-row");
    const steve = rows.find((r) => r.textContent?.includes("steve"))!;
    fireEvent.click(within(steve).getByRole("button", { name: /Reset 2FA/ }));
    fireEvent.click(within(steve).getAllByRole("button", { name: /Reset 2FA/ })[0]!);
    expect(await within(steve).findByText("2FA has been reset.")).toBeTruthy();
    expect(input(bodies, "admin.users.resetTotp")[0]).toEqual({ id: 1 });

    const other = rows.find((r) => r.textContent?.includes("blokgenoot"))!;
    fireEvent.click(within(other).getByRole("button", { name: /^Block$/ }));
    fireEvent.click(within(other).getByRole("button", { name: /^Block$/ }));
    expect(await within(other).findByText("blocked")).toBeTruthy();
    expect(input(bodies, "admin.users.setBlocked")[0]).toEqual({ id: 2, blocked: true });

    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: "123456789012345678" } });
    fireEvent.click(await screen.findByRole("button", { name: /Create in advance/ }));
    expect(await screen.findByText("Account created.")).toBeTruthy();
    expect(input(bodies, "admin.users.create")[0]).toEqual({ discordId: "123456789012345678" });
  });
});

describe("templates", () => {
  it("valideren toont fouten, opslaan roept update aan", async () => {
    const { bodies } = renderWithTrpc(<TemplateEditor id={1} onCreated={() => {}} onDeleted={() => {}} />, admin);
    const editor = (await screen.findByLabelText("editor")) as HTMLTextAreaElement;
    expect(editor.value).toContain("slug: paper");
    fireEvent.change(editor, { target: { value: "slug: paper\n" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    expect((await screen.findByTestId("validate-errors")).textContent).toMatch(/schema: verwacht 1/);
    fireEvent.change(editor, { target: { value: "schema: 1\nslug: paper\n" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    expect(await screen.findByTestId("validate-ok")).toBeTruthy();
    fireEvent.click(screen.getByTestId("template-save"));
    expect(await screen.findByText("Template saved.")).toBeTruthy();
    expect(input(bodies, "admin.templates.update")[0]).toEqual({ id: 1, yaml: "schema: 1\nslug: paper\n" });
  });

  it("nieuwe template: create en daarna door naar de nieuwe id", async () => {
    const onCreated = vi.fn();
    renderWithTrpc(<TemplateEditor id={null} onCreated={onCreated} onDeleted={() => {}} />, admin);
    fireEvent.click(await screen.findByTestId("template-save"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});

describe("activiteitenlog", () => {
  it("filtert op actie", async () => {
    const { bodies } = renderWithTrpc(<ActivityAdmin />, admin);
    expect(await screen.findAllByTestId("activity-row")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Action starts with"), { target: { value: "auth" } });
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(1));
    expect(input(bodies, "admin.activity.search").length).toBe(0); // query, geen mutation
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(3));
  });
});
