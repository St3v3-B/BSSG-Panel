// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Implementation, ServerDetail } from "@panel/api";
import { ContentManager } from "@/app/_components/server/content-manager";
import { VariablesCard } from "@/app/_components/server/server-settings";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { compareVersions, isDowngrade } from "@/app/_lib/versions";
import { renderWithTrpc, sessionFor } from "./utils";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/", useParams: () => ({}) }));
afterEach(cleanup);

const GAME = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const admin = { session: sessionFor("admin"), locale: "en" as const };
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);
const server = (over: Partial<ServerDetail> = {}) => ({ uuid: GAME, name: "SMP", type: "game", isOwner: true, permissions: ["files.read", "files.write"], variables: [], ...over }) as unknown as ServerDetail;

describe("tabblad Plugins/Mods", () => {
  const base = { uuid: GAME, type: "game" as const, isOwner: true, permissions: ["files.read"] as ServerDetail["permissions"] };
  it("alleen als de server plugins of mods ondersteunt en je files.read hebt", () => {
    expect(serverTabs({ ...base, content: "plugin" }).find((t) => t.key === "content")?.label).toBe("Plugins");
    expect(serverTabs({ ...base, content: "mod" }).find((t) => t.key === "content")?.label).toBe("Mods");
    expect(serverTabs({ ...base, content: null }).map((t) => t.key)).not.toContain("content");
    expect(serverTabs({ ...base, permissions: [], content: "plugin" }).map((t) => t.key)).not.toContain("content");
  });
});

describe("ContentManager", () => {
  it("zoeken, installeren met afhankelijkheden, melding", async () => {
    const { bodies } = renderWithTrpc(<ContentManager server={server()} />, { ...admin });
    expect((await screen.findByTestId("content-manager")).textContent).toMatch(/Minecraft 1\.21\.5/);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "hangar" } });
    expect((await screen.findAllByTestId("content-hit")).map((h) => h.textContent)).toEqual([expect.stringContaining("ViaVersion")]);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "modrinth" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "fabric" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Fabric API");
    expect(screen.queryByText("Lithium")).toBeNull();
    expect(screen.getByText("by modmuss50")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install Fabric API" }));
    const dialog = await screen.findByTestId("content-dialog");
    await within(dialog).findByText(/Version 2\.0\.0/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText(/1 file installed/);
    expect(inputs(bodies, "content.install")).toEqual([{ uuid: GAME, source: "modrinth", projectId: "fabric-api", withDependencies: false }]);
    // lijst bijgewerkt
    expect((await screen.findAllByTestId("content-installed-row"))[0]!.textContent).toContain("Fabric API");
  });

  it("afhankelijkheden worden getoond en meegeïnstalleerd", async () => {
    const { bodies } = renderWithTrpc(<ContentManager server={server()} />, { ...admin });
    await screen.findByText("Lithium");
    fireEvent.click(screen.getByRole("button", { name: "Install Lithium" }));
    const dialog = await screen.findByTestId("content-dialog");
    await within(dialog).findByText("Fabric API");
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(inputs(bodies, "content.install")).toHaveLength(1));
    expect(inputs(bodies, "content.install")[0]).toMatchObject({ projectId: "lithium", withDependencies: true });
  });

  it("bijwerken en verwijderen (met bevestiging)", async () => {
    const patch = (m: Implementation) => {
      (m.content as Mutable<typeof m.content>).list = () => [{ id: 7, source: "modrinth", projectId: "lithium", name: "Lithium", versionId: "v1", versionNumber: "1.0.0", filename: "lithium-1.0.0.jar", kind: "plugin", installedAt: new Date() }];
      (m.content as Mutable<typeof m.content>).checkUpdates = () => [{ id: 7, versionId: "v2", versionNumber: "2.0.0" }];
    };
    const { bodies } = renderWithTrpc(<ContentManager server={server()} />, { ...admin, patch });
    await screen.findByText("lithium-1.0.0.jar");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("1 update available.");
    fireEvent.click(screen.getByRole("button", { name: /Update to 2\.0\.0/ }));
    await waitFor(() => expect(inputs(bodies, "content.update")).toEqual([{ uuid: GAME, id: 7 }]));
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Lithium" }));
    expect(inputs(bodies, "content.uninstall")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete file?" }));
    await waitFor(() => expect(inputs(bodies, "content.uninstall")).toEqual([{ uuid: GAME, id: 7 }]));
  });

  it("zonder files.write geen installeer- of verwijderknoppen", async () => {
    renderWithTrpc(<ContentManager server={server({ permissions: ["files.read"] })} />, { ...admin });
    await screen.findByText("Nothing installed through the panel yet.");
    expect(screen.queryByTestId("content-search")).toBeNull();
  });

  it("niet-ondersteunde server en foutmelding bij installeren", async () => {
    const patch = (m: Implementation) => {
      (m.content as Mutable<typeof m.content>).install = () => {
        throw new (class extends Error { constructor() { super("HASH_MISMATCH: x"); } })();
      };
    };
    const { unmount } = renderWithTrpc(<ContentManager server={server()} />, { ...admin, patch });
    await screen.findByText("Lithium");
    fireEvent.click(screen.getByRole("button", { name: "Install Lithium" }));
    const dialog = await screen.findByTestId("content-dialog");
    await within(dialog).findByText("Fabric API");
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText(/./, { selector: "p.text-destructive" });
    unmount();
    renderWithTrpc(<ContentManager server={server()} />, { ...admin, patch: (m) => ((m.content as Mutable<typeof m.content>).info = () => ({ supported: false, kind: null, directory: null, loaders: [], sources: [], gameVersion: null, modpacks: false })) });
    await screen.findByText(/aren't available for this kind of server/);
  });

  it("modpack: zoeken, bevestigen, importeren; alleen voor de eigenaar op Fabric", async () => {
    const patch = (m: Implementation) => {
      (m.content as Mutable<typeof m.content>).info = () => ({ supported: true, kind: "mod", directory: "/mods", loaders: ["fabric"], sources: ["modrinth"], gameVersion: "1.21.5", modpacks: true });
    };
    const { bodies } = renderWithTrpc(<ContentManager server={server()} />, { ...admin, patch });
    await screen.findByText("Cool Pack");
    fireEvent.click(screen.getByRole("button", { name: "Import Cool Pack" }));
    const confirm = await screen.findByTestId("modpack-confirm");
    expect(inputs(bodies, "content.importModpack")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Import modpack" }));
    await screen.findByText(/Mock pack imported for Minecraft 1\.21\.5: 12 files downloaded, 3 client-only files skipped\./);
    expect(inputs(bodies, "content.importModpack")).toEqual([{ uuid: GAME, source: { type: "modrinth", projectId: "cool-pack" }, reinstall: true }]);
    cleanup();
    renderWithTrpc(<ContentManager server={server({ isOwner: false })} />, { ...admin, patch });
    await screen.findByTestId("content-search");
    expect(screen.queryByTestId("content-modpacks")).toBeNull();
  });
});

describe("versiekiezer", () => {
  const vars = [{ key: "MINECRAFT_VERSION", name: "Minecraft version", description: null, value: "1.21.4", default: "latest", userEditable: true, pattern: "^(latest|\\d+\\.\\d+(\\.\\d+)?)$" }];
  it("vergelijkt versies numeriek", () => {
    expect(compareVersions("1.21.10", "1.21.4")).toBeGreaterThan(0);
    expect(compareVersions("1.21", "1.21.1")).toBeLessThan(0);
    expect(compareVersions("1.21-rc1", "1.21")).toBeLessThan(0);
    expect(isDowngrade("1.21.4", "1.20.6")).toBe(true);
    expect(isDowngrade("1.21.4", "1.21.5")).toBe(false);
    expect(isDowngrade("latest", "1.20")).toBe(false);
  });

  it("dropdown uit de bron; oudere versie waarschuwt; na opslaan: nu herinstalleren", async () => {
    push.mockClear();
    const { bodies } = renderWithTrpc(<VariablesCard server={server({ variables: vars })} />, { ...admin });
    await waitFor(() => expect(screen.getByLabelText("Minecraft version").tagName).toBe("SELECT"));
    expect([...(screen.getByLabelText("Minecraft version") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["latest", "1.21.5", "1.21.4", "1.21.3"]);
    fireEvent.click(screen.getByLabelText("Show release candidates and snapshots"));
    expect([...(screen.getByLabelText("Minecraft version") as HTMLSelectElement).options].map((o) => o.value)).toContain("1.21.4-rc1");
    fireEvent.change(screen.getByLabelText("Minecraft version"), { target: { value: "1.21.5" } });
    expect(screen.queryByTestId("version-downgrade")).toBeNull();
    fireEvent.change(screen.getByLabelText("Minecraft version"), { target: { value: "1.21.3" } });
    expect((await screen.findByTestId("version-downgrade")).textContent).toMatch(/older version/);
    fireEvent.click(screen.getByRole("button", { name: /Save variables/ }));
    await waitFor(() => expect(inputs(bodies, "servers.updateVariables")).toEqual([{ uuid: GAME, variables: { MINECRAFT_VERSION: "1.21.3" } }]));
    const changed = await screen.findByTestId("version-changed");
    fireEvent.click(within(changed).getByRole("button", { name: "Reinstall now" }));
    await waitFor(() => expect(inputs(bodies, "servers.reinstall")).toEqual([{ uuid: GAME }]));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/servers/${GAME}`));
  });

  it("tekstveld als de lijst niet geladen kan worden", async () => {
    const patch = (m: Implementation) => {
      (m.content as Mutable<typeof m.content>).versionOptions = () => {
        throw new Error("BAD_GATEWAY");
      };
    };
    renderWithTrpc(<VariablesCard server={server({ variables: vars })} />, { ...admin, patch });
    await waitFor(() => expect(screen.getByLabelText("Minecraft version").tagName).toBe("INPUT"));
  });

  it("geen kiezer voor niet-eigenaar", async () => {
    renderWithTrpc(<VariablesCard server={server({ variables: vars, isOwner: false })} />, { ...admin });
    expect(screen.getByLabelText("Minecraft version").tagName).toBe("INPUT");
  });
});
