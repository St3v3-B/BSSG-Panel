import { panelVersionLabel } from "@panel/api";
import { afterEach, describe, expect, it } from "vitest";
import { versionInfo } from "./updates";

const SHA = "15efeda0b1c2d3e4f5061728394a5b6c7d8e9f01";
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
const running = (sha: string | undefined, number?: string) => {
  if (sha === undefined) delete process.env.PANEL_COMMIT;
  else process.env.PANEL_COMMIT = sha;
  if (number === undefined) delete process.env.PANEL_COMMIT_NUMBER;
  else process.env.PANEL_COMMIT_NUMBER = number;
};
const st = (over: Record<string, unknown> = {}) => ({ current: { sha: SHA }, commits: [{}, {}], current_number: 504, latest_number: 506, behind: 2, last_fetch: "2026-11-27T09:30:00Z", ...over });

describe("panelversie", () => {
  it("label", () => {
    expect(panelVersionLabel(504)).toBe("0.1.504");
    expect(panelVersionLabel(null)).toBeNull();
    expect(panelVersionLabel(-1)).toBeNull();
  });

  it("update beschikbaar: huidige, nieuwste, aantal achter, laatst gecontroleerd", () => {
    running(SHA);
    expect(versionInfo(st())).toEqual({ currentVersion: "0.1.504", latestVersion: "0.1.506", behind: 2, upToDate: false, checkedAt: new Date("2026-11-27T09:30:00Z") });
  });

  it("achterstand boven de 50 commits komt uit behind, niet uit de begrensde lijst", () => {
    running(SHA);
    const v = versionInfo(st({ commits: new Array(50).fill({}), latest_number: 577, behind: 73 }));
    expect(v).toMatchObject({ behind: 73, latestVersion: "0.1.577", upToDate: false });
  });

  it("up-to-date: nieuwste = huidige", () => {
    running(SHA);
    expect(versionInfo(st({ commits: [], latest_number: 504, behind: 0 }))).toMatchObject({ currentVersion: "0.1.504", latestVersion: "0.1.504", behind: 0, upToDate: true });
  });

  it("panel draait uit een andere commit dan de checkout: ingebakken nummer en verschil met origin/main", () => {
    running("0badc0de0badc0de0badc0de0badc0de0badc0de", "500");
    expect(versionInfo(st())).toMatchObject({ currentVersion: "0.1.500", latestVersion: "0.1.506", behind: 6, upToDate: false });
  });

  it("andere commit zonder ingebakken nummer: onbekend", () => {
    running("0badc0de0badc0de0badc0de0badc0de0badc0de");
    expect(versionInfo(st())).toMatchObject({ currentVersion: null, behind: null, upToDate: null });
  });

  it("oude daemon zonder getallen: achterstand uit de lijst als die niet begrensd is", () => {
    running(SHA);
    expect(versionInfo(st({ current_number: undefined, latest_number: undefined, behind: undefined, last_fetch: undefined }), Date.parse("2026-11-27T08:00:00Z"))).toEqual({
      currentVersion: null,
      latestVersion: null,
      behind: 2,
      upToDate: false,
      checkedAt: new Date("2026-11-27T08:00:00Z"),
    });
    // Begrensde lijst en geen getallen: het echte aantal is onbekend.
    expect(versionInfo(st({ current_number: undefined, latest_number: undefined, behind: undefined, commits: new Array(50).fill({}) })).behind).toBeNull();
  });

  it("geen daemon: alles onbekend, nooit gecontroleerd", () => {
    running(undefined);
    expect(versionInfo(null)).toEqual({ currentVersion: null, latestVersion: null, behind: null, upToDate: null, checkedAt: null });
  });
});
