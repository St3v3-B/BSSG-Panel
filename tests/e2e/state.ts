import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "../integration/helpers";

/** Gedeelde staat tussen specs (uuid's van de aangemaakte servers). */
export type State = { game?: string; site?: string; paper?: string; velocity?: string; quotaUser?: string; quotaUserId?: number; s3?: string; daemonPid?: number };
const file = () => `${env("IT_WORK")}/e2e-state.json`;
export const readState = (): State => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
export const saveState = (p: Partial<State>) => writeFileSync(file(), JSON.stringify({ ...readState(), ...p }));
export const need = (k: keyof State): string => {
  const v = readState()[k];
  if (!v) throw new Error(`${k} ontbreekt: een eerdere spec is mislukt`);
  return String(v);
};
