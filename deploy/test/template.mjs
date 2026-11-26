// Hulpje voor deploy/test.sh: leest een template-YAML en doet na wat de daemon doet
// ({{VAR}} vervangen, config_files bijwerken). Alleen voor tests; de echte logica zit in de daemon.
//   node template.mjs <yaml> get <veld.pad>
//   node template.mjs <yaml> startup            (vars uit env: TPL_<KEY>)
//   node template.mjs <yaml> env                (KEY=waarde per regel, defaults + ingebouwd)
//   node template.mjs <yaml> config <map>       (config_files in <map> bijwerken: properties, yaml, toml)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(new URL("../../packages/api/package.json", import.meta.url));
const { parse, parseDocument, Scalar } = require("yaml");

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
      const p = join(arg, cf.path);
      mkdirSync(dirname(p), { recursive: true });
      const old = existsSync(p) ? readFileSync(p, "utf8") : "";
      const set = Object.entries(cf.set).map(([k, v]) => [k, subst(v)]);
      const fn = { properties, yaml, toml }[cf.format];
      if (!fn) throw new Error(`${cf.format} niet ondersteund in deze test`);
      writeFileSync(p, fn(old, set));
    }
    break;
  default:
    console.error("onbekend commando");
    process.exit(2);
}

// Zoals de daemon (spec/configfiles.go): bool/getal zonder quotes, de rest als string.
function literal(v) {
  return v === "true" || v === "false" || /^-?[0-9]+(\.[0-9]+)?$/.test(v);
}

function properties(old, set) {
  const lines = old ? old.split("\n") : [];
  const todo = new Map(set);
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
  return out.join("\n") + "\n";
}

function yaml(old, set) {
  const doc = parseDocument(old);
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.contents.flow = false;
  for (const [k, v] of set) {
    const node = new Scalar(literal(v) ? parse(v) : v);
    doc.setIn(k.split("."), node);
  }
  return doc.toString();
}

// Minimaal: "a" (bovenaan) of "tabel.a"; bestaande regels in place vervangen.
function toml(old, set) {
  const lines = old ? old.split("\n") : [];
  const fmt = (v) => (literal(v) ? v : JSON.stringify(v));
  for (const [k, v] of set) {
    const i = k.lastIndexOf(".");
    const table = i < 0 ? "" : k.slice(0, i), key = i < 0 ? k : k.slice(i + 1);
    let cur = "", start = table === "" ? 0 : -1, end = lines.length, done = false;
    for (let n = 0; n < lines.length; n++) {
      const h = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(lines[n]);
      if (h) {
        if (cur === table && start >= 0 && end === lines.length) end = n;
        cur = h[1].trim();
        if (cur === table) start = n + 1;
        continue;
      }
      const m = /^\s*("?)([A-Za-z0-9_-]+)\1\s*=/.exec(lines[n]);
      if (m && cur === table && m[2] === key) { lines[n] = `${key} = ${fmt(v)}`; done = true; break; }
    }
    if (done) continue;
    if (start < 0) lines.push("", `[${table}]`, `${key} = ${fmt(v)}`);
    else lines.splice(start, 0, `${key} = ${fmt(v)}`);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
