/**
 * HTML- en platte-tekstmails in panelstijl: donkere kop met naam/logo, accentkleur uit de branding,
 * een kaart met titel, tekst, velden en een knop. Alleen inline styles en tabellen (mailclients).
 */
import type { Branding } from "@panel/api";

export type MailLevel = "info" | "success" | "warning" | "error";

export interface MailField {
  name: string;
  value: string;
  /** Monospace-blok (logregels, foutmeldingen). */
  code?: boolean;
}

export interface MailContent {
  subject: string;
  title: string;
  level: MailLevel;
  /** Alinea's platte tekst. */
  paragraphs: string[];
  fields?: MailField[];
  button?: { label: string; url: string };
  /** Kleine regel onderaan (bv. waarom je deze mail krijgt). */
  footer?: string;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const LEVEL_COLOR: Record<MailLevel, string> = { info: "#3b82f6", success: "#22c55e", warning: "#f59e0b", error: "#ef4444" };
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Leesbare tekstkleur op de accentkleur (zwart of wit). */
function onAccent(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#0b0b12" : "#ffffff";
}

/** Logo alleen als absolute https-URL (of pad op het panel); anders alleen de naam. */
function logoSrc(logoUrl: string | null, panelUrl: string): string | null {
  if (!logoUrl) return null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(logoUrl)) return logoUrl;
  if (/^\/[^\s"'<>]*$/.test(logoUrl) && !logoUrl.startsWith("//")) return `${panelUrl}${logoUrl}`;
  return null;
}

export function renderMail(c: MailContent, branding: Branding, panelUrl: string): { subject: string; html: string; text: string } {
  const accent = HEX.test(branding.accentColor) ? branding.accentColor : "#22c55e";
  const level = LEVEL_COLOR[c.level];
  const name = esc(branding.panelName);
  const logo = logoSrc(branding.logoUrl, panelUrl);
  const paras = c.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#d7d6e3">${esc(p)}</p>`).join("");
  const fields = (c.fields ?? [])
    .map((f) =>
      f.code
        ? `<tr><td style="padding:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#9b99b0">${esc(f.name)}</td></tr><tr><td><pre style="margin:0;padding:12px;background:#0b0a14;border:1px solid #2a2840;border-radius:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6e5f0;white-space:pre-wrap;word-break:break-word">${esc(f.value)}</pre></td></tr>`
        : `<tr><td style="padding:6px 0;font-size:14px;color:#d7d6e3"><span style="color:#9b99b0">${esc(f.name)}:</span> ${esc(f.value)}</td></tr>`,
    )
    .join("");
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="border-radius:8px;background:${accent}"><a href="${esc(c.button.url)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:${onAccent(accent)};text-decoration:none;border-radius:8px">${esc(c.button.label)}</a></td></tr></table>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#0f0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e1a;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px">${logo ? `<img src="${esc(logo)}" alt="" height="28" style="height:28px;vertical-align:middle;margin-right:10px;border:0">` : ""}<span style="font-size:16px;font-weight:700;color:#f4f3fa;vertical-align:middle">${name}</span></td></tr>
<tr><td style="background:#17162a;border:1px solid #2a2840;border-top:3px solid ${level};border-radius:12px;padding:24px">
<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#f4f3fa">${esc(c.title)}</h1>
${paras}${fields ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${fields}</table>` : ""}${button}
</td></tr>
<tr><td style="padding:16px 4px;font-size:12px;line-height:1.5;color:#7d7b93">${c.footer ? `${esc(c.footer)}<br>` : ""}<a href="${esc(panelUrl)}" style="color:${accent};text-decoration:none">${name}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    c.title,
    "=".repeat(Math.min(60, c.title.length)),
    "",
    ...c.paragraphs.flatMap((p) => [p, ""]),
    ...(c.fields ?? []).flatMap((f) => (f.code ? [`${f.name}:`, ...f.value.split("\n").map((l) => `  ${l}`), ""] : [`${f.name}: ${f.value}`])),
    ...(c.fields?.length ? [""] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ""] : []),
    "--",
    branding.panelName,
    ...(c.footer ? [c.footer] : []),
    panelUrl,
  ].join("\n");
  return { subject: c.subject, html, text };
}
