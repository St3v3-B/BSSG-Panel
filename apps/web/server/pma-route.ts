/** HTTP-handler van POST /api/pma/exchange: wacht op de boot en roept dan de logica in pma.ts aan. */
import { ensureBooted } from "./boot";
import { pmaExchangeUnbooted } from "./pma";

export async function pmaExchange(req: Request): Promise<Response> {
  try {
    await ensureBooted();
  } catch (e) {
    console.error("[pma] boot:", e);
    return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  return pmaExchangeUnbooted(req);
}
