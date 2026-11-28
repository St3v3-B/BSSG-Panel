// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Backup } from "@panel/api";
import { BackupManager } from "@/app/_components/backups/backup-manager";
import { ScheduleManager } from "@/app/_components/schedules/schedule-manager";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(() => cleanup());

const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ALL = ["backup.create", "backup.restore"] as const;
const INC: Backup = {
  id: 21, serverUuid: SMP, name: "elk uur 12:00", sizeBytes: 4 * 1024 ** 3, sha256: null, status: "completed", includesDatabases: false, error: null,
  createdAt: new Date("2026-11-27T12:00:00Z"), completedAt: new Date("2026-11-27T12:01:00Z"), kind: "incremental", snapshotId: "c".repeat(64), addedBytes: 12 * 1024 ** 2,
};

describe("BackupManager: incrementeel", () => {
  it("rij toont soort, toegevoegde grootte en snapshot; geen download maar bladeren", async () => {
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [INC];
      },
    });
    const row = await screen.findByTestId("backup-row");
    expect(row.textContent).toContain("Incrementeel");
    expect(row.textContent).toMatch(/12([.,]0)? MiB nieuw/);
    expect(row.textContent).toContain("Snapshot: cccccccccccc");
    expect(within(row).queryByRole("button", { name: /Downloaden|Download/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /Bestanden bekijken/ })).toBeTruthy();
  });

  it("snapshotbrowser: map openen, bestanden kiezen en terugzetten naar de oorspronkelijke plek of een submap", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [INC];
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Bestanden bekijken/ }));
    const browser = await screen.findByTestId("snapshot-browser");
    await waitFor(() => expect(within(browser).getAllByTestId("snapshot-entry")).toHaveLength(3));
    fireEvent.click(within(browser).getByRole("button", { name: "world" }));
    await waitFor(() => expect(within(browser).getByText("level.dat")).toBeTruthy());
    fireEvent.click(within(browser).getByLabelText("level.dat selecteren"));
    fireEvent.click(within(browser).getByLabelText("region selecteren"));
    expect(within(browser).getByText("2 geselecteerd")).toBeTruthy();
    // Standaard naar een nieuwe submap.
    fireEvent.click(within(browser).getByRole("button", { name: /Selectie terugzetten/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.restoreFiles")?.input).toEqual({ id: 21, paths: ["world/level.dat", "world/region"], destination: "subdir" }));
    expect((await within(browser).findByText(/Terugzetten gestart naar \/restore-/)).textContent).toBeTruthy();
    // Opnieuw, nu naar de oorspronkelijke plek.
    fireEvent.click(within(browser).getByLabelText("level.dat selecteren"));
    fireEvent.change(within(browser).getByLabelText("Waarheen"), { target: { value: "original" } });
    fireEvent.click(within(browser).getByRole("button", { name: /Selectie terugzetten/ }));
    await waitFor(() => expect(bodies.filter((b) => b.path === "backups.restoreFiles").at(-1)?.input).toEqual({ id: 21, paths: ["world/level.dat"], destination: "original" }));
    // Terug naar de hoofdmap.
    fireEvent.click(within(browser).getByRole("button", { name: /Omhoog/ }));
    await waitFor(() => expect(within(browser).getByText("server.properties")).toBeTruthy());
  });

  it("nieuwe backup: soort kiezen; standaard volgt de serverinstelling", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).settings = async () => ({ defaultKind: "incremental", retention: { keepLast: 24, keepDaily: 7, keepWeekly: 4 }, lastPruneAt: null, repositoryCreated: true });
      },
    });
    await waitFor(() => expect((screen.getByLabelText("Soort") as HTMLSelectElement).value).toBe("incremental"));
    expect(screen.getByText(/Alleen wat sinds de vorige snapshot veranderde/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Backup maken" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.create")?.input).toMatchObject({ kind: "incremental" }));
    fireEvent.change(screen.getByLabelText("Soort"), { target: { value: "full" } });
    fireEvent.click(screen.getByRole("button", { name: "Backup maken" }));
    await waitFor(() => expect(bodies.filter((b) => b.path === "backups.create").at(-1)?.input).toMatchObject({ kind: "full" }));
  });

  it("instellingen: retentie opslaan; alles 0 kan niet; zonder backup.create alleen lezen", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, { session: sessionFor("admin") });
    const card = await screen.findByTestId("backup-settings");
    await waitFor(() => expect((within(card).getByLabelText("Bewaar de laatste") as HTMLInputElement).value).toBe("10"));
    fireEvent.change(within(card).getByLabelText("Standaardsoort"), { target: { value: "incremental" } });
    fireEvent.change(within(card).getByLabelText("Bewaar de laatste"), { target: { value: "24" } });
    fireEvent.click(within(card).getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.updateSettings")?.input).toEqual({ uuid: SMP, defaultKind: "incremental", retention: { keepLast: 24, keepDaily: 7, keepWeekly: 4 } }));
    expect(await within(card).findByText("Opgeslagen.")).toBeTruthy();
    for (const l of ["Bewaar de laatste", "Eén per dag, aantal dagen", "Eén per week, aantal weken"]) fireEvent.change(within(card).getByLabelText(l), { target: { value: "0" } });
    expect(within(card).getByText("Bewaar minstens één snapshot.")).toBeTruthy();
    expect((within(card).getByRole("button", { name: "Opslaan" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderWithTrpc(<BackupManager uuid={SMP} permissions={["backup.restore"]} />, { session: sessionFor("admin") });
    const ro = await screen.findByTestId("backup-settings");
    await waitFor(() => expect((within(ro).getByLabelText("Bewaar de laatste") as HTMLInputElement).disabled).toBe(true));
    expect(within(ro).queryByRole("button", { name: "Opslaan" })).toBeNull();
  });
});

describe("ScheduleManager: backup-soort", () => {
  it("backup-actie met keuze full/incremental als payload", async () => {
    const { bodies } = renderWithTrpc(<ScheduleManager uuid={SMP} />, { session: sessionFor("admin") });
    await screen.findByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: /Schema toevoegen/ }));
    fireEvent.change(await screen.findByLabelText("Naam"), { target: { value: "Elk uur" } });
    fireEvent.change(screen.getByLabelText("Actie"), { target: { value: "backup" } });
    fireEvent.change(screen.getByLabelText("Soort backup"), { target: { value: "incremental" } });
    fireEvent.change(screen.getByLabelText("Tijdstip (cron)"), { target: { value: "0 * * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.create")?.input).toMatchObject({ action: "backup", payload: "incremental" }));
  });
});
