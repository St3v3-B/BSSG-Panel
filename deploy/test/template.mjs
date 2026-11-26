// Hulpje voor deploy/test.sh: leest een template-YAML en doet na wat de daemon doet
// ({{VAR}} vervangen, config_files bijwerken). Alleen voor tests; de echte logica zit in de daemon.
//   node template.mjs <yaml> get <veld.pad>
//   node template.mjs <yaml> startup            (vars uit env: TPL_<KEY>)
//   node template.mjs <yaml> env                (KEY=waarde per regel, defaults + ingebouwd)
//   node template.mjs <yaml> config <map>       (config_files in <map> bijwerken; alleen properties)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(new URL("../../packages/api/package.json", import.meta.url));
const { parse } = require("yaml");

const [file, cmd, arg] = process.argv.slice(2);
const t = parse(readFileSync(file, "utf8"));

const builtins = ["SERVER_UUID", "SERVER_MEMORY", "SERVER_IP", "SERVER_PORT", "TZ"];
const vars = {};
for (const v of t.variables ?? []) vars[v.key] = process.env[`TPL_${v.key}`] ?? v.default;
for (const k of builtins) if (process.env[`TPL_${k}`] !== undefined) vars[k] = process.env[`TPL_${k}`];
const subst = (s) =>
  s.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`onbekende variabele ${k}`);
    return vars[k];
  });

switch (cmd) {
  case "get": {
    let v = t;
    for (const p of arg.split(".")) v = v?.[p];
    if (v === undefined) process.exit(1);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    break;
  }
  case "startup":
    process.stdout.write(subst(t.startup));
    break;
  case "env":
    for (const [k, v] of Object.entries(vars)) process.stdout.write(`${k}=${v}\n`);
    break;
  case "config":
    for (const cf of t.config_files ?? []) {
      if (cf.format !== "properties") throw new Error(`${cf.format} niet ondersteund in deze test`);
      const p = join(arg, cf.path);
      const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
      const todo = new Map(Object.entries(cf.set).map(([k, v]) => [k, subst(v)]));
      const out = lines.map((l) => {
        const m = /^([^#!=:\s][^=:]*?)\s*[=:]/.exec(l);
        if (m && todo.has(m[1])) {
          const v = todo.get(m[1]);
          todo.delete(m[1]);
          return `${m[1]}=${v}`;
        }
        return l;
      });
      while (out.length && out[out.length - 1] === "") out.pop();
      for (const [k, v] of todo) out.push(`${k}=${v}`);
      writeFileSync(p, out.join("\n") + "\n");
    }
    break;
  default:
    console.error("onbekend commando");
    process.exit(2);
}
