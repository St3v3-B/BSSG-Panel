// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** deploy/phpmyadmin/panel-theme.js draait in elke phpMyAdmin-pagina; hier in jsdom. */
const SRC = readFileSync(resolve(__dirname, "../../../../deploy/phpmyadmin/panel-theme.js"), "utf8");
const run = () => new Function(SRC)();
const d = () => document.documentElement;

afterEach(() => {
  localStorage.clear();
  d().className = "";
  d().removeAttribute("style");
});

describe("panel-theme.js (phpMyAdmin)", () => {
  it("standaard donker, zoals het panel", () => {
    run();
    expect(d().classList.contains("panel-dark")).toBe(true);
    expect(d().classList.contains("panel-light")).toBe(false);
  });

  it("licht als het panel op licht staat; wisselt live mee", () => {
    localStorage.setItem("panel_theme", "light");
    run();
    expect(d().classList.contains("panel-light")).toBe(true);
    localStorage.setItem("panel_theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "panel_theme" }));
    expect(d().classList.contains("panel-dark")).toBe(true);
    expect(d().classList.contains("panel-light")).toBe(false);
  });

  it("neemt de accentkleur van het panel over; ongeldige waarden genegeerd", () => {
    localStorage.setItem("panel_accent", "#22c55e");
    run();
    expect(d().style.getPropertyValue("--pb-primary")).toBe("#22c55e");
    expect(d().style.getPropertyValue("--pb-primary-rgb")).toBe("34, 197, 94");
    expect(d().style.getPropertyValue("--pb-on-primary")).toBe("#0b0c14");
    localStorage.setItem("panel_accent", "red;}body{display:none");
    window.dispatchEvent(new StorageEvent("storage", { key: "panel_accent" }));
    expect(d().style.getPropertyValue("--pb-primary")).toBe("");
  });

  it("niet ingebed: geen panel-embed", () => {
    run();
    expect(d().classList.contains("panel-embed")).toBe(false);
  });
});
