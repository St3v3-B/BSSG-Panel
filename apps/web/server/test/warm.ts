/** Test-hulp: laat de monitor één keer alle nodes pollen (zoals de achtergrondtikker doet). */
import { pollAllNow } from "../node-cache";

export const warmNodeCache = (): Promise<void> => pollAllNow();
