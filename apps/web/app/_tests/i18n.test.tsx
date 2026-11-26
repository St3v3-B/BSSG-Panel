// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleSwitcher } from "@/app/_components/locale-switcher";
import { PowerButtons } from "@/app/_components/power-buttons";
import { StatusBadge } from "@/app/_components/status-badge";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { DICTS, LOCALE_COOKIE, LocaleProvider, parseLocale } from "@/app/_lib/i18n";
import { en } from "@/app/_lib/i18n/en";
import { nl } from "@/app/_lib/i18n/nl";

afterEach(() => {
  cleanup();
  document.cookie = `${LOCALE_COOKIE}=; max-age=0; path=/`;
});

/** Alle sleutelpaden met het soort waarde (string, functie met n parameters, lijst). */
function shape(v: unknown, path = ""): string[] {
  if (typeof v === "function") return [`${path}:fn${v.length}`];
  if (Array.isArray(v)) return [`${path}:array`];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => shape(x, path ? `${path}/${k}` : k));
  return [`${path}:${typeof v}`];
}

describe("woordenboeken", () => {
  it("en en nl hebben precies dezelfde sleutels en soorten waarden", () => {
    expect(shape(nl).sort()).toEqual(shape(en).sort());
  });

  it("geen lege teksten", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      const empty = shape(dict).filter((k) => k.endsWith(":string")).filter((k) => {
        const val = k.split(":")[0]!.split("/").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], dict);
        return val === "" && !k.startsWith("domains/alsoRedirectSuffix");
      });
      expect(empty, locale).toEqual([]);
    }
  });

  it("zonder (geldige) cookie Engels", () => {
    expect(parseLocale(undefined)).toBe("en");
    expect(parseLocale("de")).toBe("en");
    expect(parseLocale("nl")).toBe("nl");
  });
});

function Probe() {
  return (
    <>
      <LocaleSwitcher />
      <StatusBadge status="disk_exceeded" />
      <PowerButtons status="offline" onPower={() => {}} />
      <span data-testid="err">{errorText({ message: "DISK_EXCEEDED", data: { code: "PRECONDITION_FAILED" } })}</span>
      <span data-testid="perm">{errorText({ message: "MISSING_PERMISSION: files.write", data: { code: "FORBIDDEN" } })}</span>
      <span data-testid="date">{formatDate(new Date("2026-11-26T12:00:00Z"))}</span>
    </>
  );
}

describe("taalwissel", () => {
  it("standaard Engels, wissel naar Nederlands zet de cookie en <html lang>", () => {
    render(
      <LocaleProvider initial="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: /Start/ }).textContent).toMatch(/^\s*Start$/);
    expect(screen.getByText("Disk full")).toBeTruthy();
    expect(screen.getByTestId("err").textContent).toMatch(/disk is full/);
    expect(screen.getByTestId("perm").textContent).toBe("You don't have permission for this on this server. (Change files)");
    expect(screen.getByTestId("date").textContent).toMatch(/Nov/);

    fireEvent.click(screen.getByRole("button", { name: "nl" }));
    expect(screen.getByRole("button", { name: /Starten/ })).toBeTruthy();
    expect(screen.getByText("Schijf vol")).toBeTruthy();
    expect(screen.getByTestId("err").textContent).toMatch(/schijf van deze server is vol/);
    expect(screen.getByTestId("perm").textContent).toMatch(/\(Bestanden wijzigen\)$/);
    expect(screen.getByTestId("date").textContent).toMatch(/nov/);
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=nl`);
    expect(document.documentElement.lang).toBe("nl");
    expect(screen.getByRole("button", { name: "nl" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "en" }));
    expect(screen.getByText("Disk full")).toBeTruthy();
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
  });
});
