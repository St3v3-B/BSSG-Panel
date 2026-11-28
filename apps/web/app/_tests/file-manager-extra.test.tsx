// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS } from "@panel/api/schemas";
import { FileManager } from "@/app/_components/files/file-manager";
import { hasSpecialBits, isValidMode, modeToOctal, modeToString, toggleModeBit } from "@/app/_lib/files";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);

const UUID = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const owner = { uuid: UUID, permissions: [...ALL_PERMISSIONS] };

/** Opent een Radix-dropdown (reageert op pointerdown met de linkerknop). */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("modus-hulpjes", () => {
  it("leest Go- en ls-stijl en schakelt bits", () => {
    expect(modeToOctal("-rw-r--r--")).toBe("644");
    expect(modeToOctal("drwxr-xr-x")).toBe("755");
    expect(modeToOctal("dgrwxrwxr-x")).toBe("2775");
    expect(modeToOctal("urwxr-xr-x")).toBe("4755");
    expect(modeToOctal("rwsr-xr-t")).toBe("5755");
    expect(modeToOctal("Lrwxrwxrwx")).toBe("777");
    expect(modeToOctal("onzin")).toBe("644");
    expect(toggleModeBit("644", 0o100, true)).toBe("744");
    expect(toggleModeBit("744", 0o4000, true)).toBe("4744");
    expect(toggleModeBit("4744", 0o4000, false)).toBe("744");
    expect(modeToString("4755")).toBe("rwsr-xr-x");
    expect(modeToString("1777")).toBe("rwxrwxrwt");
    expect(modeToString("640")).toBe("rw-r-----");
    expect(hasSpecialBits("0755")).toBe(false);
    expect(hasSpecialBits("2755")).toBe(true);
    expect(isValidMode("888")).toBe(false);
  });
});

describe("FileManager: zoeken", () => {
  it("op naam: resultaten klikbaar naar editor of map", async () => {
    const onEdit = vi.fn();
    const onNavigate = vi.fn();
    const { calls } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={onNavigate} onEdit={onEdit} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.change(screen.getByRole("searchbox", { name: "Zoeken" }), { target: { value: "server" } });
    fireEvent.submit(screen.getByTestId("file-search-form"));
    const panel = await screen.findByTestId("file-search-results");
    await within(panel).findAllByTestId("search-hit");
    expect(calls.some((c) => c.includes("files.search"))).toBe(true);
    expect(within(panel).getAllByTestId("search-hit").map((h) => h.textContent)).toEqual([expect.stringContaining("/server.properties"), expect.stringContaining("/server.jar")]);
    expect(panel.textContent).toMatch(/2 resultaten/);
    fireEvent.click(within(panel).getByText("/server.jar"));
    expect(onNavigate).toHaveBeenCalledWith("/");
    expect(screen.queryByTestId("file-search-results")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Zoeken" }), { target: { value: "server" } });
    fireEvent.submit(screen.getByTestId("file-search-form"));
    fireEvent.click(await screen.findByText("/server.properties"));
    expect(onEdit).toHaveBeenCalledWith("/server.properties");
  });

  it("op inhoud: toont regelnummers; niets gevonden", async () => {
    renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.click(screen.getByLabelText("In inhoud zoeken"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Zoeken" }), { target: { value: "MAX-players" } });
    fireEvent.submit(screen.getByTestId("file-search-form"));
    const hit = await screen.findByTestId("search-hit");
    expect(hit.textContent).toMatch(/regel 3/);
    expect(hit.textContent).toMatch(/max-players=20/);

    fireEvent.change(screen.getByRole("searchbox", { name: "Zoeken" }), { target: { value: "bestaatnergens" } });
    fireEvent.submit(screen.getByTestId("file-search-form"));
    await screen.findByText("Niets gevonden.");
    fireEvent.click(screen.getByRole("button", { name: "Zoeken sluiten" }));
    expect(screen.queryByTestId("file-search-results")).toBeNull();
  });
});

describe("FileManager: rechten", () => {
  it("octaal invullen stuurt files.chmod; speciale bits pas na bevestiging", async () => {
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    openMenu(screen.getByRole("button", { name: "Acties voor server.properties" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rechten/ }));
    const dialog = await screen.findByTestId("chmod-dialog");
    const octal = within(dialog).getByLabelText("Octaal") as HTMLInputElement;
    expect(octal.value).toBe("644");
    expect(within(dialog).queryByText(/recursief/)).toBeNull(); // geen map
    fireEvent.click(within(dialog).getByLabelText("Eigenaar uitvoeren"));
    expect(octal.value).toBe("744");
    expect(within(dialog).getByTestId("file-mode-string").textContent).toBe("rwxr--r--");

    fireEvent.change(octal, { target: { value: "64" } });
    fireEvent.blur(octal);
    expect(within(dialog).getByText(/octale cijfers|octal digits/i)).toBeTruthy(); // zichtbaar zonder submit (Apply staat uit)
    fireEvent.change(octal, { target: { value: "4755" } });
    expect(within(dialog).getByTestId("chmod-special")).toBeTruthy();
    const apply = within(dialog).getByRole("button", { name: "Toepassen" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/bewust setuid/));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() =>
      expect(bodies.find((b) => b.path === "files.chmod")?.input).toEqual({ uuid: UUID, paths: ["/server.properties"], mode: "4755", dirMode: "4755", recursive: false, allowSpecial: true }),
    );
    await screen.findByText("Rechten gezet op 1 item.");
    expect(screen.queryByTestId("chmod-dialog")).toBeNull();
  });

  it("map recursief: aparte modus voor bestanden en mappen", async () => {
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.click(screen.getByLabelText("plugins selecteren"));
    fireEvent.click(within(screen.getByTestId("selection-bar")).getByRole("button", { name: /Rechten/ }));
    const dialog = await screen.findByTestId("chmod-dialog");
    fireEvent.click(within(dialog).getByLabelText(/recursief/));
    expect((within(dialog).getByLabelText("Bestanden: Octaal") as HTMLInputElement).value).toBe("644");
    expect((within(dialog).getByLabelText("Mappen: Octaal") as HTMLInputElement).value).toBe("755");
    fireEvent.change(within(dialog).getByLabelText("Mappen: Octaal"), { target: { value: "750" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Toepassen" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "files.chmod")?.input).toEqual({ uuid: UUID, paths: ["/plugins"], mode: "644", dirMode: "750", recursive: true, allowSpecial: false }));
  });
});

describe("FileManager: archief, verplaatsen", () => {
  it("selectie downloaden als tar.gz via archiveUrl", async () => {
    const downloadArchive = vi.fn();
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} downloadArchive={downloadArchive} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.click(screen.getByLabelText("world selecteren"));
    fireEvent.click(screen.getByLabelText("server.jar selecteren"));
    openMenu(within(screen.getByTestId("selection-bar")).getByRole("button", { name: /Downloaden/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Downloaden als .tar.gz" }));
    await waitFor(() => expect(downloadArchive).toHaveBeenCalledWith(expect.stringContaining("/files/archive")));
    expect(bodies.find((b) => b.path === "files.archiveUrl")?.input).toEqual({ uuid: UUID, root: "/", paths: ["/world", "/server.jar"], format: "tar.gz" });
  });

  it("map in een submap downloaden: de map zelf in het archief", async () => {
    const downloadArchive = vi.fn();
    const { bodies } = renderWithTrpc(<FileManager server={{ uuid: UUID, permissions: ["files.read"] }} path="/plugins" onNavigate={() => {}} onEdit={() => {}} downloadArchive={downloadArchive} />, {
      session: sessionFor("admin"),
    });
    await screen.findByText(/Deze map is leeg/);
    openMenu(screen.getByRole("button", { name: /Map downloaden/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Downloaden als .zip" }));
    await waitFor(() => expect(downloadArchive).toHaveBeenCalled());
    expect(bodies.find((b) => b.path === "files.archiveUrl")?.input).toEqual({ uuid: UUID, root: "/", paths: ["/plugins"], format: "zip" });
  });

  it("verplaatsen naar een map", async () => {
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.click(screen.getByLabelText("server.jar selecteren"));
    fireEvent.click(screen.getByLabelText("server.properties selecteren"));
    fireEvent.click(within(screen.getByTestId("selection-bar")).getByRole("button", { name: /Verplaatsen/ }));
    const input = screen.getByLabelText("Doelmap (bijv. /plugins)") as HTMLInputElement;
    expect(input.value).toBe("/");
    fireEvent.change(input, { target: { value: "plugins" } });
    fireEvent.click(within(screen.getByTestId("move-prompt")).getByRole("button", { name: /Verplaatsen/ }));
    expect(screen.getByText("Vul een map in die met / begint")).toBeTruthy();
    fireEvent.change(input, { target: { value: "/plugins/" } });
    fireEvent.click(within(screen.getByTestId("move-prompt")).getByRole("button", { name: /Verplaatsen/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "files.move")?.input).toEqual({ uuid: UUID, paths: ["/server.jar", "/server.properties"], destination: "/plugins" }));
    await screen.findByText("2 items verplaatst.");
  });

  it("alleen files.read: wel downloaden, geen rechten of verplaatsen", async () => {
    renderWithTrpc(<FileManager server={{ uuid: UUID, permissions: ["files.read"] }} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    fireEvent.click(screen.getByLabelText("world selecteren"));
    const bar = screen.getByTestId("selection-bar");
    expect(within(bar).getByRole("button", { name: /Downloaden/ })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: /Verplaatsen/ })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /Rechten/ })).toBeNull();
    openMenu(screen.getByRole("button", { name: "Acties voor world" }));
    await screen.findByRole("menuitem", { name: "Downloaden als .zip" });
    expect(screen.queryByRole("menuitem", { name: /Rechten/ })).toBeNull();
  });
});
