// Eigenaar: orchestrator (skelet). Draait één keer bij de start van de Node-server.
// De logica (migraties, eigenaar, lokale node, templates, JWT-sleutel) zit in server/boot.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.PANEL_MOCK === "1") return;
  const { boot } = await import("./server/boot");
  await boot();
}
