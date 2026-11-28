/** Welke commit draait er op een node, en loopt die achter op het panel? */

const SHA = /^[0-9a-f]{7,40}$/;

/** Commit uit /api/system (`commit`, gezet door install.sh) of uit de versie `0.1.0-<sha>` (panel-image, remote nodes). */
export function daemonCommitOf(version: string | null | undefined, commit?: string | null): string | null {
  const c = commit?.trim().toLowerCase();
  if (c && SHA.test(c)) return c;
  const m = /-([0-9a-f]{7,40})$/.exec(version?.trim().toLowerCase() ?? "");
  return m ? m[1]! : null;
}

/** Commit van het draaiende panel (ingebakken in de image); null bij een ontwikkelbuild. */
export function panelCommit(): string | null {
  const c = process.env.PANEL_COMMIT?.trim().toLowerCase();
  return c && SHA.test(c) ? c : null;
}

/** Alleen als beide bekend zijn; korte en lange sha's vergelijken op het gemeenschappelijke begin. */
export function isOutdated(nodeCommit: string | null, panel: string | null = panelCommit()): boolean {
  if (!nodeCommit || !panel) return false;
  const n = Math.min(nodeCommit.length, panel.length);
  return nodeCommit.slice(0, n) !== panel.slice(0, n);
}
