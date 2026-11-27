// Eigenaar: orchestrator. UI-code mag uit de index van @panel/api alleen types importeren:
// de index laadt ook de tRPC-router (@trpc/server), en die crasht in de browser
// ("You're trying to use @trpc/server in a non-server environment").
// Waarden komen uit een subpad zoals "@panel/api/schemas".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "app");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "api" || n === "_tests" ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("client-imports", () => {
  it("geen runtime-imports uit de index van @panel/api in app/", () => {
    const bad: string[] = [];
    for (const f of files(root)) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@panel\/api";/g)) {
        if (m[1]) continue;
        const vals = m[2]!.split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type "));
        if (vals.length) bad.push(`${f.slice(root.length)}: ${vals.join(", ")}`);
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s+"@panel\/api";/.test(s)) bad.push(`${f.slice(root.length)}: import *`);
    }
    expect(bad).toEqual([]);
  });
});
