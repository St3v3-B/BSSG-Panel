import { describe, expect, it } from "vitest";
import { makeRewriter, rewriteDump, rewriteSqlLine, wordpressPrefix, wordpressSiteUrlSql } from "./dump-rewrite";

const FROM = "staging.shop.test";
const TO = "shop.test";
const ser = (s: string) => `s:${Buffer.byteLength(s)}:"${s}";`;
/** Zoals de stroom het ziet: bytes als latin1. */
const L = (s: string) => Buffer.from(s, "utf8").toString("latin1");

describe("makeRewriter().value", () => {
  it("gewone tekst: alleen ://host en :\\/\\/host, met hostgrens", () => {
    const r = makeRewriter(FROM, TO);
    expect(r.value(`<a href="https://${FROM}/x">`)).toBe(`<a href="https://${TO}/x">`);
    expect(r.value(`{"url":"https:\\/\\/${FROM}\\/a"}`)).toBe(`{"url":"https:\\/\\/${TO}\\/a"}`);
    expect(r.value(`https://${FROM}.evil.test/ en https://x${FROM}/`)).toBe(`https://${FROM}.evil.test/ en https://x${FROM}/`);
    expect(r.value(`mail ${FROM} zonder schema`)).toBe(`mail ${FROM} zonder schema`);
    expect(r.value(`ga naar http://${FROM}.`)).toBe(`ga naar http://${TO}.`);
    expect(r.stats).toEqual({ replaced: 3, skipped: 0 });
  });

  it("geserialiseerde PHP: lengtes in bytes kloppen, ook genest en met UTF-8", () => {
    const r = makeRewriter(FROM, TO);
    const inner = `a:1:{s:3:"url";${ser(`https://${FROM}/ü`)}}`;
    const v = `a:3:{s:4:"home";${ser(`https://${FROM}`)}i:0;${ser(inner)}s:1:"n";O:8:"stdClass":1:{s:1:"b";b:1;}}`;
    const out = r.value(L(v));
    const innerOut = `a:1:{s:3:"url";${ser(`https://${TO}/ü`)}}`;
    expect(out).toBe(L(`a:3:{s:4:"home";${ser(`https://${TO}`)}i:0;${ser(innerOut)}s:1:"n";O:8:"stdClass":1:{s:1:"b";b:1;}}`));
    expect(r.stats.replaced).toBe(2);
  });

  it("kapotte of onbekende serialisatie: ongemoeid en geteld als overgeslagen", () => {
    const r = makeRewriter(FROM, TO);
    const broken = `a:1:{s:3:"url";s:99:"https://${FROM}";}`;
    expect(r.value(broken)).toBe(broken);
    const custom = `C:11:"ArrayObject":21:{x:i:0;s:13:"https://${FROM}";}`;
    expect(r.value(custom)).toBe(custom);
    expect(r.stats).toEqual({ replaced: 0, skipped: 2 });
  });

  it("weigert ongeldige hosts", () => {
    expect(() => makeRewriter("a'b", TO)).toThrow();
  });
});

describe("rewriteSqlLine", () => {
  it("ontsleutelt, herschrijft en sleutelt opnieuw; _binary en andere regels blijven gelijk", () => {
    const r = makeRewriter(FROM, TO);
    const opt = ser(`https://${FROM}/it's`);
    const sqlv = opt.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
    const line = `INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://${FROM}','yes'),(2,'w','${sqlv}','no'),(3,'b',_binary 'https://${FROM}','no'),(4,'x','geen\\nhost','no');\n`;
    const out = rewriteSqlLine(line, r);
    const expOpt = ser(`https://${TO}/it's`).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
    expect(out).toBe(`INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://${TO}','yes'),(2,'w','${expOpt}','no'),(3,'b',_binary 'https://${FROM}','no'),(4,'x','geen\\nhost','no');\n`);
    expect(rewriteSqlLine(`-- https://${FROM}\n`, r)).toBe(`-- https://${FROM}\n`);
  });
});

describe("rewriteDump (stroom)", () => {
  it("over chunkgrenzen heen, met toegevoegde SQL aan het eind", async () => {
    const dump = `-- dump\nINSERT INTO t VALUES ('https://${FROM}/a');\nINSERT INTO t VALUES ('${ser(`http://${FROM}`).replace(/"/g, '\\"')}');\n`;
    const bytes = Buffer.from(dump);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
        c.close();
      },
    });
    const r = makeRewriter(FROM, TO);
    const out = await new Response(rewriteDump(src, r, wordpressSiteUrlSql("wp_", FROM, TO))).text();
    expect(out).toContain(`INSERT INTO t VALUES ('https://${TO}/a');`);
    expect(out).toContain(`('${ser(`http://${TO}`).replace(/"/g, '\\"')}')`);
    expect(out.trim().endsWith(`UPDATE \`wp_options\` SET option_value = REPLACE(option_value, '://${FROM}', '://${TO}') WHERE option_name IN ('siteurl', 'home');`)).toBe(true);
    expect(r.stats.replaced).toBe(2);
  });
});

describe("wordpress", () => {
  it("prefix uit wp-config.php", () => {
    expect(wordpressPrefix("<?php\n$table_prefix = 'wp_';\n")).toBe("wp_");
    expect(wordpressPrefix('$table_prefix  = "abc_" ;')).toBe("abc_");
    expect(wordpressPrefix("$table_prefix = $x;")).toBeNull();
    expect(() => wordpressSiteUrlSql("wp_; DROP", FROM, TO)).toThrow();
  });
});
