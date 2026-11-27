// Kopieert Monaco (monaco-editor/min/vs, AMD-build) naar public/monaco/vs, zodat de editor van het panel zelf laadt
// en niet van een CDN (CSP: alleen 'self'). Draait vóór `next dev` en `next build`; de map staat in .gitignore.
// Alles in vs/ laadt Monaco pas als een editor opent (loader.js + chunks op aanvraag), dus de app-bundle groeit niet.
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = realpathSync(join(here, "node_modules/monaco-editor"));
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const src = join(pkgDir, "min/vs");
const dst = join(here, "public/monaco/vs");
const stamp = join(here, "public/monaco/VERSION");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version && existsSync(join(dst, "loader.js"))) {
  console.log(`monaco ${version}: already in public/monaco`);
} else {
  rmSync(join(here, "public/monaco"), { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  writeFileSync(stamp, `${version}\n`);
  console.log(`monaco ${version}: copied to public/monaco/vs`);
}
