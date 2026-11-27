// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleManager } from "@/app/_components/schedules/schedule-manager";
import { PhpSettingsCard } from "@/app/_components/server/php-settings-card";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(() => cleanup());
const SMP = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";

describe("ScheduleManager exec", () => {
  it("websites get the exec action, game servers do not", async () => {
    const { bodies } = renderWithTrpc(<ScheduleManager uuid={SMP} web />, { session: sessionFor("admin"), locale: "en" });
    await screen.findByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: /Add schedule/ }));
    const action = (await screen.findByLabelText("Action")) as HTMLSelectElement;
    expect([...action.options].map((o) => o.value)).toEqual(["restart", "backup", "exec"]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "WP cron" } });
    fireEvent.change(action, { target: { value: "exec" } });
    fireEvent.change(screen.getByLabelText(/Command \(runs in the site container\)/), { target: { value: "php public/wp-cron.php" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "schedules.create")?.input).toMatchObject({ action: "exec", payload: "php public/wp-cron.php" }));
    cleanup();
    renderWithTrpc(<ScheduleManager uuid={SMP} />, { session: sessionFor("admin"), locale: "en" });
    fireEvent.click(await screen.findByRole("button", { name: /Add schedule/ }));
    const a2 = (await screen.findByLabelText("Action")) as HTMLSelectElement;
    expect([...a2.options].map((o) => o.value)).toEqual(["restart", "command", "backup"]);
  });
});

describe("PhpSettingsCard", () => {
  it("shows effective values, validates memory against the RAM and saves", async () => {
    const { bodies } = renderWithTrpc(<PhpSettingsCard uuid={SMP} />, { session: sessionFor("admin"), locale: "en" });
    const mem = (await screen.findByLabelText("Memory limit (memory_limit)")) as HTMLInputElement;
    expect(mem.value).toBe("256");
    fireEvent.change(mem, { target: { value: "2048" } });
    expect((screen.getByRole("button", { name: /Save and restart/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(mem, { target: { value: "512" } });
    fireEvent.click(screen.getByLabelText("opcache", { exact: false }));
    fireEvent.click(screen.getByLabelText("exif"));
    fireEvent.click(screen.getByRole("button", { name: /Save and restart/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "siteSettings.updatePhp")?.input).toMatchObject({ uuid: SMP, settings: { memoryLimitMb: 512, opcache: false, disabledExtensions: ["exif"] } }));
    await screen.findByText(/Saved\. The site is restarting/);
  });
});
