/** Hulpfuncties om tRPC-fouten te lezen en vertaald te tonen. */
import { getT, type Dict } from "@/app/_lib/i18n";

export interface ErrorInfo {
  code: string | null; // tRPC-code, bv. "FORBIDDEN"
  message: string; // ruwe message, bv. "BLOCKED"
}

export function errorInfo(err: unknown): ErrorInfo {
  if (!err || typeof err !== "object") return { code: null, message: String(err ?? "") };
  const e = err as { message?: unknown; data?: { code?: unknown } | null; shape?: { data?: { code?: unknown } } };
  const code = e.data?.code ?? e.shape?.data?.code;
  return { code: typeof code === "string" ? code : null, message: typeof e.message === "string" ? e.message : "" };
}

export const isBlocked = (err: unknown) => {
  const i = errorInfo(err);
  return i.code === "FORBIDDEN" && i.message === "BLOCKED";
};

export const isTotpPending = (err: unknown) => {
  const i = errorInfo(err);
  return i.code === "FORBIDDEN" && i.message === "TOTP_PENDING";
};

export const isDiskExceeded = (err: unknown) => {
  const i = errorInfo(err);
  return i.message === "DISK_EXCEEDED" || (i.code === "PRECONDITION_FAILED" && i.message.startsWith("DISK_EXCEEDED"));
};

export const isForbidden = (err: unknown) => errorInfo(err).code === "FORBIDDEN";

export const isUnauthorized = (err: unknown) => errorInfo(err).code === "UNAUTHORIZED";

/** Leesbare foutmelding in de huidige taal voor een tRPC-fout. */
export function errorText(err: unknown, t: Dict = getT()): string {
  const { code, message } = errorInfo(err);
  const key = message.split(/[\s(:]/)[0] ?? "";
  const messages = t.errors.messages as Record<string, string>;
  const codes = t.errors.codes as Record<string, string>;
  if (messages[key]) {
    if (key === "MISSING_PERMISSION") {
      // "MISSING_PERMISSION: files.write" → naam van het recht erbij
      const perm = message.slice(key.length).replace(/^[:\s]+/, "").trim() as keyof Dict["permissions"];
      const label = perm && perm !== "all" ? (t.permissions[perm] as { label: string } | undefined)?.label : undefined;
      return label ? `${messages[key]} (${label})` : messages[key]!;
    }
    // mock-hints zoals "(mock: gebruik 123456)" laten we zien
    const hint = message.match(/\((mock[^)]*)\)/)?.[1];
    return hint ? `${messages[key]} (${hint})` : messages[key]!;
  }
  if (code && codes[code]) {
    // korte, bruikbare messages van de server tonen we erbij
    return message && message !== code && message.length < 200 && !message.startsWith("[") ? `${codes[code]} ${message}` : codes[code]!;
  }
  return message || t.errors.unknown;
}
