/** Codevoorbeelden voor de API-documentatie, met het eigen paneldomein ingevuld. */

export type ExampleLang = "curl" | "python" | "js";

export const EXAMPLE_LANGS: Array<{ id: ExampleLang; label: string }> = [
  { id: "curl", label: "curl" },
  { id: "python", label: "Python" },
  { id: "js", label: "JavaScript" },
];

/** Basis-URL van de REST-API bij een origin (zonder slash aan het eind). */
export const apiBase = (origin: string) => `${origin.replace(/\/+$/, "")}/api/v1`;

/** Een kort script: servers ophalen, de eerste herstarten, een bestand schrijven. */
export function quickstart(origin: string, lang: ExampleLang): string {
  const base = apiBase(origin);
  switch (lang) {
    case "curl":
      return [
        `export PANEL_KEY="<your API key>"`,
        ``,
        `# your servers`,
        `curl -s -H "Authorization: Bearer $PANEL_KEY" ${base}/servers`,
        ``,
        `# restart a server`,
        `curl -s -X POST -H "Authorization: Bearer $PANEL_KEY" -H "Content-Type: application/json" \\`,
        `  -d '{"action":"restart"}' ${base}/servers/<uuid>/power`,
        ``,
        `# upload a text file (the body is the content)`,
        `curl -s -X PUT -H "Authorization: Bearer $PANEL_KEY" --data-binary @index.html \\`,
        `  "${base}/servers/<uuid>/files/contents?path=/public/index.html"`,
      ].join("\n");
    case "python":
      return [
        `import os, requests`,
        ``,
        `BASE = "${base}"`,
        `s = requests.Session()`,
        `s.headers["Authorization"] = f"Bearer {os.environ['PANEL_KEY']}"`,
        ``,
        `servers = s.get(f"{BASE}/servers").json()`,
        `uuid = servers[0]["uuid"]`,
        `s.post(f"{BASE}/servers/{uuid}/power", json={"action": "restart"}).raise_for_status()`,
        `s.put(f"{BASE}/servers/{uuid}/files/contents", params={"path": "/public/index.html"},`,
        `      data=open("index.html", "rb")).raise_for_status()`,
      ].join("\n");
    case "js":
      return [
        `const BASE = "${base}";`,
        `const headers = { Authorization: \`Bearer \${process.env.PANEL_KEY}\` };`,
        ``,
        `const servers = await (await fetch(\`\${BASE}/servers\`, { headers })).json();`,
        `const uuid = servers[0].uuid;`,
        `await fetch(\`\${BASE}/servers/\${uuid}/power\`, {`,
        `  method: "POST",`,
        `  headers: { ...headers, "Content-Type": "application/json" },`,
        `  body: JSON.stringify({ action: "restart" }),`,
        `});`,
      ].join("\n");
  }
}

/** curl-voorbeeld voor één endpoint. */
export function curlFor(origin: string, method: string, path: string, opts: { query?: string[]; jsonBody?: boolean; textBody?: boolean } = {}): string {
  const q = opts.query?.length ? `?${opts.query.map((k) => `${k}=/`).join("&")}` : "";
  const url = `${apiBase(origin)}${path}${q}`;
  const parts = [`curl -s`];
  if (method !== "GET") parts.push(`-X ${method}`);
  parts.push(`-H "Authorization: Bearer $PANEL_KEY"`);
  if (opts.jsonBody) parts.push(`-H "Content-Type: application/json" -d '{…}'`);
  if (opts.textBody) parts.push(`--data-binary @file.txt`);
  parts.push(q ? `"${url}"` : url);
  return parts.join(" ");
}
