import type { PowerAction, ServerStatus } from "@panel/api";
import type { trpc } from "@/lib/trpc";

type Utils = ReturnType<typeof trpc.useUtils>;

/** Status die direct getoond wordt na een power-knop; de daemon bevestigt hem daarna. */
export const OPTIMISTIC_STATUS: Record<PowerAction, ServerStatus> = { start: "starting", stop: "stopping", restart: "stopping", kill: "offline" };

/**
 * Optimistische update voor `servers.power`: zet de status meteen in `servers.get` en `servers.list`.
 * Gebruik in `onMutate` en geef de teruggegeven functie aan `onError` om terug te draaien.
 */
export async function applyOptimisticPower(utils: Utils, uuid: string, action: PowerAction): Promise<() => void> {
  await Promise.all([utils.servers.get.cancel({ uuid }), utils.servers.list.cancel()]);
  const status = OPTIMISTIC_STATUS[action];
  const prevGet = utils.servers.get.getData({ uuid });
  const prevList = utils.servers.list.getData();
  utils.servers.get.setData({ uuid }, (d) => (d ? { ...d, status } : d));
  utils.servers.list.setData(undefined, (l) => l?.map((s) => (s.uuid === uuid ? { ...s, status } : s)));
  return () => {
    utils.servers.get.setData({ uuid }, prevGet);
    utils.servers.list.setData(undefined, prevList);
  };
}
