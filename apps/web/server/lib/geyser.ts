/**
 * GeyserMC: Geyser + Floodgate ophalen via de officiële download-API (sha256 uit de API gecontroleerd)
 * en de Geyser-configuratie. Niets wordt uitgevoerd; de jars gaan via de daemon-bestands-API naar `plugins/`.
 */
import { createHash, randomBytes } from "node:crypto";
import { ExternalError, fetchBytes, fetchJson } from "./http";

export const GEYSER_API = "https://download.geysermc.org/v2/projects";
export const GEYSER_HOSTS = ["download.geysermc.org"] as const;
export const GEYSER_MAX_BYTES = 50 * 1024 * 1024; // = schrijflimiet van de daemon (Geyser-Spigot is nu ~49,8 MiB; groeit hij erboven, dan faalt aanzetten met een duidelijke fout)
export const DEFAULT_BEDROCK_PORT = 19132;

export type GeyserProject = "geyser" | "floodgate";
export type GeyserPlatform = "spigot" | "velocity";

export interface GeyserJar {
  project: GeyserProject;
  filename: string;
  version: string;
  build: number;
  data: Buffer;
}

const SAFE = /^[A-Za-z][A-Za-z0-9._-]{0,80}\.jar$/;

/** Haalt de nieuwste build van `project` voor `platform`; faalt bij een afwijkende sha256. */
export async function downloadGeyserJar(project: GeyserProject, platform: GeyserPlatform): Promise<GeyserJar> {
  const base = `${GEYSER_API}/${project}/versions/latest/builds/latest`;
  const info = await fetchJson<{ version?: string; build?: number; downloads?: Record<string, { name?: string; sha256?: string } | undefined> }>(base, { hosts: GEYSER_HOSTS });
  const d = info.downloads?.[platform];
  if (!d?.name || !d.sha256 || !/^[0-9a-f]{64}$/i.test(d.sha256) || !SAFE.test(d.name) || typeof info.build !== "number") {
    throw new ExternalError("EXTERNAL_BAD_RESPONSE", `${project}: no ${platform} download in the API response`);
  }
  const data = await fetchBytes(`${base}/downloads/${platform}`, { hosts: GEYSER_HOSTS, maxBytes: GEYSER_MAX_BYTES, timeoutMs: 60_000 });
  if (createHash("sha256").update(data).digest("hex") !== d.sha256.toLowerCase()) throw new ExternalError("HASH_MISMATCH", `sha256 of ${d.name} does not match the API`);
  return { project, filename: d.name, version: info.version ?? "", build: info.build, data };
}

/** Vaste bestandsnamen in `plugins/` (wat de API als naam teruggeeft wordt alleen gecontroleerd), zodat uitzetten altijd raak is. */
export const jarName = (project: GeyserProject, p: GeyserPlatform) => (project === "geyser" ? `Geyser-${p === "spigot" ? "Spigot" : "Velocity"}.jar` : `floodgate-${p}.jar`);

/** Mappen voor de plugins van een platform (Geyser en Floodgate gebruiken hun eigen naam). */
export const geyserDir = (p: GeyserPlatform) => `/plugins/Geyser-${p === "spigot" ? "Spigot" : "Velocity"}`;
export const geyserConfigPath = (p: GeyserPlatform) => `${geyserDir(p)}/config.yml`;
export const FLOODGATE_KEY_PATH = "/plugins/floodgate/key.pem";

/**
 * config.yml voor Geyser: Bedrock luistert op UDP `port` (alle interfaces in de container), Java-kant is de
 * server zelf (`127.0.0.1:<javaPort>`), authenticatie via Floodgate (Bedrock-spelers hebben geen Java-account nodig).
 * Geyser 2.9+ leest dit formaat (echt getest met 2.12.1: start, RakNet-ping op de UDP-poort beantwoord, key.pem blijft behouden).
 */
export function geyserConfig(o: { port: number; javaPort: number }): string {
  return `# Written by the panel (Bedrock toggle). Changes to these keys are overwritten when Bedrock is switched on again.
bedrock:
  address: 0.0.0.0
  port: ${o.port}
  clone-remote-port: false
  # Geyser 2.12 defaults to NetherNet (signaling over TCP + its own UDP port). "both" also answers classic RakNet
  # on UDP \`port\`, which is the one port the panel opens. NetherNet then logs a harmless warning (it needs a second UDP port).
  transport: both
java:
  auth-type: floodgate
  address: 127.0.0.1
  port: ${o.javaPort}
`;
}

/** Floodgate-sleutel: 128-bit AES, ruw in key.pem (precies wat Floodgate zelf aanmaakt). Proxy en backends delen hem. */
export const newFloodgateKey = (): Buffer => randomBytes(16);
