// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NodeDetail } from "@/app/_components/admin/nodes";
import { S3TargetsAdmin } from "@/app/_components/admin/settings";
import { BackupManager } from "@/app/_components/backups/backup-manager";
import { ScheduleManager } from "@/app/_components/schedules/schedule-manager";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { previewCron } from "@/app/_lib/cron";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(() => cleanup());

const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ALL = ["backup.create", "backup.restore"] as const;

describe("serverTabs", () => {
  it("backups- en schematabblad op basis van rechten", () => {
    const keys = (permissions: Parameters<typeof serverTabs>[0]["permissions"]) => serverTabs({ uuid: SMP, type: "game", isOwner: false, permissions }).map((x) => x.key);
    expect(keys(["backup.restore"])).toEqual(["console", "backups", "settings"]);
    expect(keys(["schedule.manage"])).toEqual(["console", "schedules", "settings"]);
    expect(keys(["files.write"])).toEqual(["console", "settings"]);
  });
});

describe("BackupManager", () => {
  it("toont backups met grootte, checksum en status", async () => {
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("backup-row");
    expect(within(row).getByText("daily 2026-11-26")).toBeTruthy();
    expect(within(row).getByText("Klaar")).toBeTruthy();
    expect(row.textContent).toContain("a".repeat(64));
  });

  it("toont de reden van een mislukte backup", async () => {
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [{ id: 9, serverUuid: SMP, name: "kapot", sizeBytes: null, sha256: null, status: "failed", includesDatabases: false, error: "S3 upload failed: access denied", createdAt: new Date(), completedAt: new Date(), kind: "full" as const, snapshotId: null, addedBytes: null }];
      },
    });
    expect((await screen.findByTestId("backup-error")).textContent).toContain("S3 upload failed: access denied");
  });

  it("maakt een backup met naam; lopende backup toont voortgang", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, { session: sessionFor("admin") });
    await screen.findByTestId("backup-row");
    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "voor update" } });
    fireEvent.click(screen.getByRole("button", { name: "Backup maken" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.create")?.input).toEqual({ uuid: SMP, name: "voor update", includeDatabases: true, kind: "full" }));
    await waitFor(() => expect(screen.getAllByTestId("backup-row")).toHaveLength(2));
    const rows = screen.getAllByTestId("backup-row");
    const running = rows.find((r) => r.textContent?.includes("voor update"))!;
    expect(within(running).getByText("Bezig")).toBeTruthy();
    expect(within(running).getByRole("progressbar")).toBeTruthy();
  });

  it("live voortgang (ook na herladen): fase, percentage, bytes, ETA en annuleren", async () => {
    const started = new Date(Date.now() - 30_000);
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [{ id: 5, serverUuid: SMP, name: "nachtelijk", sizeBytes: null, sha256: null, status: "running", includesDatabases: false, error: null, createdAt: started, completedAt: null, kind: "full" as const, snapshotId: null, addedBytes: null }];
        (m.backups as Mutable<typeof m.backups>).progress = async () => ({ backupId: 5, operation: "backup", phase: "archiving", bytes: 420 * 1024 * 1024, totalBytes: 800 * 1024 * 1024, percent: 42, etaSeconds: 125, startedAt: started, cancellable: true });
      },
    });
    const bar = await screen.findByRole("progressbar", { name: "Uploaden" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    const box = screen.getByTestId("backup-progress");
    expect(box.textContent).toContain("42%");
    expect(box.textContent).toMatch(/420([.,]0)? MiB van 800([.,]0)? MiB/);
    expect(box.textContent).toContain("nog ongeveer 2m 5s");
    fireEvent.click(within(box).getByRole("button", { name: /Annuleren/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.cancel")?.input).toEqual({ id: 5 }));
  });

  it("geen annuleerknop als het niet meer kan of zonder recht; zonder live gegevens een bezig-balk", async () => {
    const started = new Date();
    const row = { id: 6, serverUuid: SMP, name: "herstel", sizeBytes: 10, sha256: "b".repeat(64), status: "restoring" as const, includesDatabases: false, error: null, createdAt: started, completedAt: null, kind: "full" as const, snapshotId: null, addedBytes: null };
    renderWithTrpc(<BackupManager uuid={SMP} permissions={["backup.restore"]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [row];
        (m.backups as Mutable<typeof m.backups>).progress = async () => ({ backupId: 6, operation: "restore", phase: "applying", bytes: 10, totalBytes: 10, percent: 99, etaSeconds: null, startedAt: started, cancellable: false });
      },
    });
    await screen.findByRole("progressbar", { name: "Data terugzetten" });
    expect(within(screen.getByTestId("backup-progress")).queryByRole("button")).toBeNull();
    cleanup();
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [{ ...row, status: "running" }];
        (m.backups as Mutable<typeof m.backups>).progress = async () => null;
      },
    });
    const bar = await screen.findByRole("progressbar", { name: "Bezig" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  it("een geannuleerde backup toont 'Geannuleerd' in plaats van een fout", async () => {
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).list = async () => [{ id: 7, serverUuid: SMP, name: "weg", sizeBytes: null, sha256: null, status: "failed", includesDatabases: false, error: "cancelled", createdAt: new Date(), completedAt: new Date(), kind: "full" as const, snapshotId: null, addedBytes: null }];
      },
    });
    expect((await screen.findByTestId("backup-error")).textContent).toBe("Geannuleerd");
  });

  it("herstellen vraagt eerst bevestiging en waarschuwt dat bestanden vervangen worden", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("backup-row");
    fireEvent.click(within(row).getByRole("button", { name: /Herstellen/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/vervangen/);
    expect(bodies.some((b) => b.path === "backups.restore")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuleren" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Herstellen/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Ja, herstellen" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.restore")?.input).toEqual({ id: 1 }));
    expect(await screen.findByText(/Herstel gestart/)).toBeTruthy();
  });

  it("verwijderen vraagt bevestiging", async () => {
    const { bodies } = renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("backup-row");
    fireEvent.click(within(row).getByRole("button", { name: /Verwijderen daily/ }));
    expect(bodies.some((b) => b.path === "backups.delete")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "backups.delete")?.input).toEqual({ id: 1 }));
    await waitFor(() => expect(screen.queryByTestId("backup-row")).toBeNull());
  });

  it("alleen backup.restore: geen maakformulier en geen verwijderknop; alleen backup.create: geen herstel/download", async () => {
    const a = renderWithTrpc(<BackupManager uuid={SMP} permissions={["backup.restore"]} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("backup-row");
    expect(screen.queryByRole("button", { name: "Backup maken" })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Verwijderen/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /Downloaden/ })).toBeTruthy();
    a.unmount();
    renderWithTrpc(<BackupManager uuid={SMP} permissions={["backup.create"]} />, { session: sessionFor("admin") });
    const row2 = await screen.findByTestId("backup-row");
    expect(screen.getByRole("button", { name: "Backup maken" })).toBeTruthy();
    expect(within(row2).queryByRole("button", { name: /Herstellen/ })).toBeNull();
    expect(within(row2).queryByRole("button", { name: /Downloaden/ })).toBeNull();
  });

  it("vertaalt serverfouten (geen S3-doel)", async () => {
    renderWithTrpc(<BackupManager uuid={SMP} permissions={[...ALL]} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.backups as Mutable<typeof m.backups>).create = () => {
          throw Object.assign(new Error("NO_S3_TARGET"), { code: "PRECONDITION_FAILED" });
        };
      },
    });
    await screen.findByTestId("backup-row");
    fireEvent.click(screen.getByRole("button", { name: "Backup maken" }));
    expect(await screen.findByText(/geen backupopslag ingesteld/)).toBeTruthy();
  });
});

describe("previewCron", () => {
  it("geeft de volgende uitvoeringen in Europe/Amsterdam en weigert ongeldige expressies", () => {
    const p = previewCron("0 4 * * *", 2, new Date("2026-11-27T12:00:00Z"));
    expect(p.ok && p.next.map((d) => d.toISOString())).toEqual(["2026-11-28T03:00:00.000Z", "2026-11-29T03:00:00.000Z"]);
    expect(previewCron("nonsense").ok).toBe(false);
    expect(previewCron("0 0 4 * * *").ok).toBe(false);
    expect(previewCron("61 * * * *").ok).toBe(false);
  });
});

describe("ScheduleManager", () => {
  it("toont schema's met laatste resultaat en volgende keer", async () => {
    renderWithTrpc(<ScheduleManager uuid={SMP} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("schedule-row");
    expect(within(row).getByText("Daily restart")).toBeTruthy();
    expect(within(row).getByText("Herstarten")).toBeTruthy();
    expect(row.textContent).toMatch(/Gelukt/);
    expect(row.textContent).toMatch(/Volgende keer/);
  });

  it("maakt een schema met cron-hulp en voorvertoning; ongeldige cron blokkeert opslaan", async () => {
    const { bodies } = renderWithTrpc(<ScheduleManager uuid={SMP} />, { session: sessionFor("admin") });
    await screen.findByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: /Schema toevoegen/ }));
    fireEvent.change(await screen.findByLabelText("Naam"), { target: { value: "Opslaan" } });
    fireEvent.change(screen.getByLabelText("Actie"), { target: { value: "command" } });
    fireEvent.change(screen.getByLabelText("Commando"), { target: { value: "save-all" } });
    // Voorbeeld kiezen vult de expressie in en toont de volgende keren.
    fireEvent.change(screen.getAllByLabelText("Voorbeeld kiezen…")[0]!, { target: { value: "*/5 * * * *" } });
    expect((screen.getByLabelText("Tijdstip (cron)") as HTMLInputElement).value).toBe("*/5 * * * *");
    expect(within(screen.getByTestId("cron-preview")).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.change(screen.getByLabelText("Tijdstip (cron)"), { target: { value: "bla" } });
    expect(within(screen.getByTestId("cron-preview")).getByText("Geen geldige cron-expressie")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    expect(bodies.some((b) => b.path === "schedules.create")).toBe(false);
    fireEvent.change(screen.getByLabelText("Tijdstip (cron)"), { target: { value: "*/5 * * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.create")?.input).toEqual({ uuid: SMP, name: "Opslaan", cron: "*/5 * * * *", action: "command", payload: "save-all", active: true }));
    await waitFor(() => expect(screen.getAllByTestId("schedule-row")).toHaveLength(2));
  });

  it("uitzetten, nu uitvoeren en verwijderen", async () => {
    const { bodies } = renderWithTrpc(<ScheduleManager uuid={SMP} />, { session: sessionFor("admin") });
    const row = await screen.findByTestId("schedule-row");
    fireEvent.click(within(row).getByRole("button", { name: /Nu uitvoeren/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.runNow")?.input).toEqual({ id: 1 }));
    fireEvent.click(within(row).getByRole("button", { name: /Uitzetten/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.update")?.input).toMatchObject({ id: 1, active: false, cron: "0 5 * * *" }));
    fireEvent.click(within(row).getByRole("button", { name: /Verwijderen Daily restart/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.delete")?.input).toEqual({ id: 1 }));
  });
});

describe("S3TargetsAdmin", () => {
  it("toont doelen zonder geheimen en test de verbinding", async () => {
    const { bodies } = renderWithTrpc(<S3TargetsAdmin />, { session: sessionFor("admin") });
    const card = await screen.findByTestId("s3-target");
    expect(card.textContent).toContain("Unraid");
    expect(card.textContent).toContain("AKIA");
    fireEvent.click(within(card).getByRole("button", { name: "Verbinding testen" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "admin.s3Targets.test")).toBeTruthy());
  });

  it("test-resultaat bij een fout wordt getoond", async () => {
    renderWithTrpc(<S3TargetsAdmin />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.admin.s3Targets as Mutable<typeof m.admin.s3Targets>).test = () => ({ ok: false, error: "AccessDenied: nope" });
      },
    });
    const card = await screen.findByTestId("s3-target");
    fireEvent.click(within(card).getByRole("button", { name: "Verbinding testen" }));
    expect(await within(card).findByText(/Mislukt: AccessDenied: nope/)).toBeTruthy();
  });

  it("nieuw doel vereist alle velden en stuurt sleutels mee", async () => {
    const { bodies } = renderWithTrpc(<S3TargetsAdmin />, { session: sessionFor("admin") });
    await screen.findByTestId("s3-target");
    fireEvent.click(screen.getByRole("button", { name: /Opslag toevoegen/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Opslaan" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(bodies.some((b) => b.path === "admin.s3Targets.create")).toBe(false);
    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "Nieuw" } });
    fireEvent.change(screen.getByLabelText("Endpoint (URL)"), { target: { value: "http://nas.test:9000" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "bk" } });
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AKTEST" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "geheim" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() =>
      expect(bodies.find((b) => b.path === "admin.s3Targets.create")?.input).toEqual({ name: "Nieuw", endpoint: "http://nas.test:9000", bucket: "bk", region: "us-east-1", pathStyle: true, accessKey: "AKTEST", secretKey: "geheim" }),
    );
  });
});

describe("standaardopslag per node", () => {
  it("kiest een S3-doel voor de node en bewaart het", async () => {
    const { bodies } = renderWithTrpc(<NodeDetail id={1} onDeleted={() => {}} />, { session: sessionFor("admin") });
    const card = await screen.findByTestId("node-backup-target");
    await within(card).findByRole("option", { name: "Unraid" });
    fireEvent.change(within(card).getByRole("combobox"), { target: { value: "1" } });
    fireEvent.click(within(card).getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "admin.nodes.update")?.input).toMatchObject({ id: 1, s3TargetId: 1 }));
  });
});
