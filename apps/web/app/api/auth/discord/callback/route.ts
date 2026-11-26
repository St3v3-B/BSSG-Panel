import { ensureBooted } from "@/server/boot";
import { finishLogin } from "@/server/discord";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  await ensureBooted();
  return finishLogin(req);
}
