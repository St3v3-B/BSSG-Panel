/** Hulpfuncties om tRPC-fouten te lezen en in het Nederlands te tonen. */

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

const MESSAGES: Record<string, string> = {
  BLOCKED: "Je account is geblokkeerd. Neem contact op met een beheerder.",
  TOTP_PENDING: "Voer eerst je 2FA-code in.",
  TOTP_REQUIRED: "Zet eerst tweestapsverificatie (2FA) aan op je accountpagina.",
  NOT_ADMIN: "Hiervoor moet je beheerder zijn.",
  DAEMON_UNREACHABLE: "De node is op dit moment niet bereikbaar. Probeer het straks opnieuw.",
  INVALID_CODE: "Die code klopt niet. Probeer het opnieuw.",
  DISK_EXCEEDED: "De schijf van deze server is vol. Verwijder eerst bestanden of vraag een beheerder om meer ruimte.",
};

const CODES: Record<string, string> = {
  UNAUTHORIZED: "Je bent niet (meer) ingelogd.",
  FORBIDDEN: "Je hebt hier geen rechten voor.",
  NOT_FOUND: "Niet gevonden.",
  CONFLICT: "Dit bestaat al of botst met iets anders.",
  BAD_REQUEST: "Ongeldige invoer.",
  PRECONDITION_FAILED: "Dit kan nu niet (bijvoorbeeld omdat de schijf vol is).",
  TOO_MANY_REQUESTS: "Te veel pogingen. Wacht even en probeer het opnieuw.",
  INTERNAL_SERVER_ERROR: "Er ging iets mis op de server.",
};

/** Leesbare Nederlandse foutmelding voor een tRPC-fout. */
export function errorText(err: unknown): string {
  const { code, message } = errorInfo(err);
  const key = message.split(/[\s(:]/)[0] ?? "";
  if (MESSAGES[key]) {
    // mock-hints zoals "(mock: gebruik 123456)" laten we zien
    const hint = message.match(/\((mock[^)]*)\)/)?.[1];
    return hint ? `${MESSAGES[key]} (${hint})` : MESSAGES[key]!;
  }
  if (code && CODES[code]) {
    // korte, bruikbare messages van de server tonen we erbij
    return message && message !== code && message.length < 200 && !message.startsWith("[") ? `${CODES[code]} ${message}` : CODES[code]!;
  }
  return message || "Onbekende fout.";
}
