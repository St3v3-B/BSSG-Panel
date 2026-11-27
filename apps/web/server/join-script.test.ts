// Regressie: het panel vervangt __PANEL_URL__ overal in join.sh; de controle "URL niet ingevuld"
// mag daardoor niet zelf de echte URL gaan weigeren.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../../deploy/join/join.sh");

function guard(url: string): string {
  const script = readFileSync(SRC, "utf8").replaceAll("__PANEL_URL__", url);
  const line = script.split("\n").find((l) => l.includes("unknown panel URL"))!;
  const dir = mkdtempSync(join(tmpdir(), "join-guard-"));
  const f = join(dir, "g.sh");
  writeFileSync(f, `die() { echo "DIE $*"; exit 0; }\nPANEL_URL="$1"\n${line}\necho PASS\n`);
  return execFileSync("bash", [f, url], { encoding: "utf8" }).trim();
}

describe("join.sh na vervanging van de placeholder", () => {
  it("de echte panel-URL komt door de controle", () => {
    expect(guard("https://panel.test")).toBe("PASS");
  });
  it("een niet-ingevulde placeholder wordt nog steeds geweigerd", () => {
    const script = readFileSync(SRC, "utf8");
    const line = script.split("\n").find((l) => l.includes("unknown panel URL"))!;
    const dir = mkdtempSync(join(tmpdir(), "join-guard-"));
    const f = join(dir, "g.sh");
    writeFileSync(f, `die() { echo "DIE $*"; exit 0; }\nPANEL_URL=__PANEL_URL__\n${line}\necho PASS\n`);
    expect(execFileSync("bash", [f], { encoding: "utf8" }).trim()).toMatch(/^DIE/);
  });
});
