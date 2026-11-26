import { ensureBooted } from "@/server/boot";
import { startLogin } from "@/server/discord";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  await ensureBooted();
  return startLogin(req);
}
