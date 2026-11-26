// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@panel/api";
import { CreateServerForm, variableError } from "@/app/_components/create-server-form";
import { renderWithTrpc, sessionFor } from "./utils";

afterEach(cleanup);

const submit = () => fireEvent.click(screen.getByRole("button", { name: /Server aanmaken/ }));

describe("CreateServerForm", () => {
  it("valideert en maakt een server aan voor een vooraf aangemaakte gebruiker", async () => {
    const onCreated = vi.fn<(s: ServerDetail) => void>();
    const { bodies } = renderWithTrpc(<CreateServerForm onCreated={onCreated} />, { session: sessionFor("admin") });
    await screen.findByTestId("create-server-form");

    // leeg versturen → meldingen, geen aanroep
    submit();
    expect((await screen.findByTestId("form-invalid")).textContent).toMatch(/naam.*eigenaar.*poort/);

    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "Survival" } });

    // eigenaar vooraf aanmaken op Discord-ID
    fireEvent.change(screen.getByLabelText("Eigenaar"), { target: { value: "123456789012345678" } });
    fireEvent.click(await screen.findByRole("button", { name: /Vooraf aanmaken/ }));
    expect((await screen.findByTestId("selected-owner")).textContent).toContain("123456789012345678");

    // template-variabele met patroon
    const version = await screen.findByLabelText("Minecraft-versie");
    expect((version as HTMLInputElement).value).toBe("latest");
    fireEvent.change(version, { target: { value: "geen versie" } });

    // twee vrije poorten, de tweede primair maken
    fireEvent.click(await screen.findByLabelText("203.0.113.10:25567"));
    fireEvent.click(screen.getByLabelText("203.0.113.10:25568"));
    fireEvent.click(screen.getByRole("button", { name: "Maak primair" }));

    // limieten komen uit de instellingen
    expect((screen.getByLabelText("Geheugen (MB)") as HTMLInputElement).value).toBe("4096");
    fireEvent.change(screen.getByLabelText("Geheugen (MB)"), { target: { value: "2048" } });

    submit();
    expect((await screen.findByTestId("form-invalid")).textContent).toMatch(/variabelen/);
    fireEvent.change(version, { target: { value: "1.21.4" } });
    submit();

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const s = onCreated.mock.calls[0]![0];
    expect(s.name).toBe("Survival");
    expect(s.owner.discordId).toBe("123456789012345678");
    expect(s.limits.ramMb).toBe(2048);
    // de eerste allocation is de primaire: 25568 (id 4) vóór 25567 (id 3)
    const input = bodies.find((b) => b.path === "admin.servers.create")!.input as { allocationIds: number[]; startOnInstall: boolean };
    expect(input.allocationIds).toEqual([4, 3]);
    expect(input.startOnInstall).toBe(true);
    expect(s.allocations.map((a) => a.port).sort()).toEqual([25567, 25568]);
    expect(s.variables.find((v) => v.key === "MINECRAFT_VERSION")?.value).toBe("1.21.4");
    expect(s.status).toBe("installing");
  });

  it("een website heeft geen poorten nodig", async () => {
    const onCreated = vi.fn();
    renderWithTrpc(<CreateServerForm onCreated={onCreated} />, { session: sessionFor("admin") });
    await screen.findByTestId("create-server-form");
    fireEvent.change(screen.getByLabelText("Naam"), { target: { value: "site" } });
    fireEvent.click(await screen.findByRole("option", { name: /blokgenoot/ }));
    fireEvent.click(screen.getByRole("button", { name: "Website" }));
    const web = await screen.findByTestId("web-templates");
    fireEvent.click(within(web).getByRole("radio", { name: /Statische site/ }));
    expect(within(web).getByRole("radio", { name: /Statische site/ }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(screen.queryByTestId("allocations")).toBeNull());
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ type: "web", allocations: [] });
  });

  it("variableError controleert het patroon", () => {
    expect(variableError("latest", "^(latest|\\d+\\.\\d+(\\.\\d+)?)$")).toBeNull();
    expect(variableError("x", "^\\d+$")).toMatch(/patroon/);
    expect(variableError("x", null)).toBeNull();
    expect(variableError("x", "(")).toBeNull();
  });
});
