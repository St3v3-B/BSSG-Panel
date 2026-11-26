/** Hulpcode voor de filemanager: paden, talen voor Monaco en upload/download naar de daemon. */

/** Normaliseert naar een pad dat met "/" begint, zonder dubbele of afsluitende slashes. */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

export const joinPath = (dir: string, name: string) => normalizePath(`${dir}/${name}`);
export const parentPath = (p: string) => normalizePath(`${p}/..`);
export const baseName = (p: string) => normalizePath(p).split("/").pop() ?? "";

/** Kruimelpad: [{name:"/", path:"/"}, {name:"plugins", path:"/plugins"}, …] */
export function breadcrumbs(p: string): Array<{ name: string; path: string }> {
  const out = [{ name: "/", path: "/" }];
  let cur = "";
  for (const seg of normalizePath(p).split("/").filter(Boolean)) {
    cur += `/${seg}`;
    out.push({ name: seg, path: cur });
  }
  return out;
}

/** Geldige bestandsnaam (geen slashes, niet . of ..). */
export function fileNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Vul een naam in";
  if (n.includes("/") || n.includes("\\")) return "Geen slashes in de naam";
  if (n === "." || n === "..") return "Ongeldige naam";
  if (n.length > 255) return "Naam is te lang";
  return null;
}

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz|tar\.zst|gz|rar|7z)$/i;
export const isArchive = (name: string) => ARCHIVE_RE.test(name);

const LANGS: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", json: "json", yml: "yaml", yaml: "yaml",
  html: "html", htm: "html", css: "css", scss: "scss", php: "php", py: "python", sh: "shell", bash: "shell", xml: "xml",
  md: "markdown", sql: "sql", ini: "ini", properties: "ini", toml: "ini", conf: "ini", cfg: "ini", java: "java", lua: "lua",
};
/** Monaco-taal op basis van de bestandsnaam. */
export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === ".htaccess" || lower === ".env") return "ini";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return LANGS[ext] ?? "plaintext";
}

/** Max grootte die files.read teruggeeft (contract: 5 MB tekst). */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const BINARY_MIME = /^(image|video|audio|font)\/|^application\/(java-archive|zip|gzip|x-tar|x-7z|octet-stream|pdf|x-rar|zstd|x-executable)/;
export function isEditable(entry: { isDirectory: boolean; size: number; mimeType: string; name: string }): boolean {
  if (entry.isDirectory || entry.size > MAX_EDIT_BYTES) return false;
  if (isArchive(entry.name)) return false;
  return !BINARY_MIME.test(entry.mimeType);
}

/** Zet een queryparameter op een (al ondertekende) URL, als die er nog niet op staat. */
export function withParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has(key)) u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return url;
  }
}

export const isMockMode = (env: string | undefined = process.env.NEXT_PUBLIC_PANEL_MOCK) => env === "1";

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Tekst voor een mislukte upload; 507 = schijf vol (daemon: disk_exceeded). */
export function uploadErrorText(err: unknown): string {
  if (err instanceof UploadError) {
    if (err.status === 507) return "Upload mislukt: de schijf van deze server is vol.";
    if (err.status === 401 || err.status === 403) return "Upload mislukt: geen rechten (of de upload-link is verlopen).";
    if (err.status === 413) return "Upload mislukt: het bestand is te groot.";
    if (err.status === 0) return "Upload mislukt: de node is niet bereikbaar.";
    return `Upload mislukt (HTTP ${err.status}).`;
  }
  return err instanceof Error ? err.message : "Upload mislukt.";
}

/**
 * Uploadt bestanden als multipart (`files`) naar de daemon-URL uit `files.uploadUrl`.
 * In mock-modus bestaat de daemon niet; dan doen we alsof (met voortgang).
 */
export function uploadFiles(
  url: string,
  directory: string,
  files: File[],
  onProgress?: (fraction: number) => void,
  opts: { mock?: boolean; xhr?: () => XMLHttpRequest } = {},
): Promise<void> {
  if (opts.mock ?? isMockMode()) {
    return new Promise((resolve) => {
      let f = 0;
      const t = setInterval(() => {
        f = Math.min(1, f + 0.25);
        onProgress?.(f);
        if (f >= 1) {
          clearInterval(t);
          resolve();
        }
      }, 120);
    });
  }
  return new Promise((resolve, reject) => {
    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    const xhr = opts.xhr?.() ?? new XMLHttpRequest();
    xhr.open("POST", withParam(url, "directory", directory));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError(xhr.responseText || `HTTP ${xhr.status}`, xhr.status)));
    xhr.onerror = () => reject(new UploadError("netwerkfout", 0));
    xhr.send(body);
  });
}

/** Start een download via een tijdelijke link (de daemon stuurt Content-Disposition: attachment). */
export function startDownload(url: string, path: string) {
  const href = withParam(url, "path", path);
  if (isMockMode()) {
    window.alert(`Mock-modus: de download zou starten via\n${href}`);
    return;
  }
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.download = baseName(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
}
