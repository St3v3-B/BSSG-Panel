/** Hulpcode voor de filemanager: paden, talen voor Monaco en upload/download naar de daemon. */
import { getT } from "@/app/_lib/i18n";

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
  const t = getT().files;
  const n = name.trim();
  if (!n) return t.nameEmpty;
  if (n.includes("/") || n.includes("\\")) return t.nameSlash;
  if (n === "." || n === "..") return t.nameInvalid;
  if (n.length > 255) return t.nameTooLong;
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
  const t = getT().files;
  if (err instanceof UploadError) {
    if (err.status === 507) return t.uploadDisk;
    if (err.status === 401 || err.status === 403) return t.uploadAuth;
    if (err.status === 413) return t.uploadTooLarge;
    if (err.status === 0) return t.uploadNetwork;
    return t.uploadHttp(err.status);
  }
  return err instanceof Error ? err.message : t.uploadFailed;
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
  openDownload(withParam(url, "path", path), baseName(path));
}

/** Start een archief-download (zip/tar.gz); de selectie zit in het token, de naam geeft de daemon. */
export function startArchiveDownload(url: string) {
  openDownload(url, "");
}

function openDownload(href: string, name: string) {
  if (isMockMode()) {
    window.alert(getT().files.mockDownload(href));
    return;
  }
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- rechten (chmod) ----------

/** Geldige octale modus voor files.chmod: 3 of 4 cijfers 0-7. */
export const isValidMode = (m: string) => /^[0-7]{3,4}$/.test(m);
/** Bevat setuid (4), setgid (2) of sticky (1) in het vierde cijfer. */
export const hasSpecialBits = (m: string) => isValidMode(m) && m.length === 4 && m[0] !== "0";

/**
 * Octale modus uit de mode-string van FileEntry. Zowel Go-stijl ("-rwxr-xr-x", "dgrwxr-xr-x":
 * u/g/t vooraan = setuid/setgid/sticky) als ls-stijl ("rwsr-sr-t") werkt. Onbekend → "644".
 */
export function modeToOctal(mode: string): string {
  const perms = mode.slice(-9);
  if (!/^[-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]$/.test(perms)) return "644";
  const prefix = mode.slice(0, -9);
  let special = (prefix.includes("u") ? 4 : 0) | (prefix.includes("g") ? 2 : 0) | (prefix.includes("t") ? 1 : 0);
  const digit = (i: number) => {
    const [r, w, x] = perms.slice(i, i + 3);
    return (r === "r" ? 4 : 0) | (w === "w" ? 2 : 0) | (x === "x" || x === "s" || x === "t" ? 1 : 0);
  };
  if ("sS".includes(perms[2]!)) special |= 4;
  if ("sS".includes(perms[5]!)) special |= 2;
  if ("tT".includes(perms[8]!)) special |= 1;
  const base = `${digit(0)}${digit(3)}${digit(6)}`;
  return special ? `${special}${base}` : base;
}

/** Zet of wist één bit (bv. 0o400 = eigenaar lezen, 0o4000 = setuid) in een geldige octale modus. */
export function toggleModeBit(mode: string, bit: number, on: boolean): string {
  const v = isValidMode(mode) ? parseInt(mode, 8) : 0o644;
  const next = on ? v | bit : v & ~bit;
  const s = (next & 0o7777).toString(8);
  return next & 0o7000 ? s.padStart(4, "0") : (next & 0o777).toString(8).padStart(3, "0");
}

/** Of een bit aan staat in een (geldige) octale modus. */
export const modeHasBit = (mode: string, bit: number) => isValidMode(mode) && (parseInt(mode, 8) & bit) !== 0;

/** Leesbare vorm, bv. "755" → "rwxr-xr-x". */
export function modeToString(mode: string): string {
  if (!isValidMode(mode)) return "";
  const v = parseInt(mode, 8);
  const ch = (bit: number, c: string) => (v & bit ? c : "-");
  const x = (bit: number, special: number, on: string, off: string) => (v & special ? (v & bit ? on : off) : ch(bit, "x"));
  return (
    ch(0o400, "r") + ch(0o200, "w") + x(0o100, 0o4000, "s", "S") +
    ch(0o040, "r") + ch(0o020, "w") + x(0o010, 0o2000, "s", "S") +
    ch(0o004, "r") + ch(0o002, "w") + x(0o001, 0o1000, "t", "T")
  );
}
