/** MOTD-instellingen voor slapende servers, gecachet zodat buildServerSpec synchroon blijft. */
export interface SleepMotdConfig {
  promo: string;
  showLogoIcon: boolean;
  seedLogoIcon: boolean;
}

/** Zelfde standaard als de daemon (`&`-kleurcodes). */
export const DEFAULT_PROMO = "&e⚡ &fJoin to wake it up &8• &7Hosted on &b&lBSSG Panel";

let current: SleepMotdConfig = { promo: DEFAULT_PROMO, showLogoIcon: true, seedLogoIcon: true };

export const getSleepMotdConfig = (): SleepMotdConfig => current;
export function setSleepMotdConfig(c: SleepMotdConfig): void {
  current = c;
}
