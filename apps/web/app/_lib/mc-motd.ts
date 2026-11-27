/** `&`-kleurcodes (`&a`, `&l`, `&r`, `&#rrggbb`, `&&`) omzetten naar gekleurde stukken tekst; zelfde regels als de daemon. */
export interface McSpan {
  text: string;
  color: string;
  bold: boolean;
}

export const MC_COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa", "4": "#aa0000", "5": "#aa00aa", "6": "#ffaa00", "7": "#aaaaaa",
  "8": "#555555", "9": "#5555ff", a: "#55ff55", b: "#55ffff", c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff",
};

export function parseMcCodes(s: string): McSpan[] {
  const out: McSpan[] = [];
  let color = MC_COLORS.f!;
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, color, bold });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const n = s[i + 1]?.toLowerCase();
    if (c !== "&" || n === undefined) {
      buf += c;
    } else if (n === "&") {
      buf += "&";
      i++;
    } else if (n === "#" && /^[0-9a-f]{6}$/i.test(s.slice(i + 2, i + 8))) {
      flush();
      color = `#${s.slice(i + 2, i + 8).toLowerCase()}`;
      bold = false;
      i += 7;
    } else if (n === "l") {
      flush();
      bold = true;
      i++;
    } else if (n === "r") {
      flush();
      color = MC_COLORS.f!;
      bold = false;
      i++;
    } else if (MC_COLORS[n]) {
      flush();
      color = MC_COLORS[n]!;
      bold = false;
      i++;
    } else {
      buf += c;
    }
  }
  flush();
  return out;
}
