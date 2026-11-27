/**
 * Ingang van de echte backend. Eigenaar: panel-api.
 * Procedures die nog niet aan de beurt zijn (latere fases) blijven NOT_IMPLEMENTED.
 */
import { notImplemented, type Implementation } from "@panel/api";
import { admin } from "./routers/admin";
import { apps } from "./routers/apps";
import { backups, s3Targets } from "./routers/backups";
import { schedules } from "./routers/schedules";
import { siteSettings } from "./routers/site-settings";
import { account, auth } from "./routers/auth";
import { credentials } from "./routers/credentials";
import { databaseHosts, databases } from "./routers/databases";
import { dnsProviders } from "./routers/dns-providers";
import { domains } from "./routers/domains";
import { nodeMutations } from "./routers/nodes";
import { content } from "./routers/content";
import { files } from "./routers/files";
import { network } from "./routers/network";
import { quotaAccount, quotaAdmin, quotaServers } from "./routers/quotas";
import { notificationsAccount, notificationsAdmin, notificationsServer } from "./routers/notifications";
import { servers } from "./routers/servers";
import { subusers } from "./routers/subusers";

export { createContext } from "./context";

type Tree = { [k: string]: Tree | ((...a: never[]) => unknown) };

function merge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    out[k] = typeof v === "function" || typeof b === "function" || !b ? v : merge(b, v);
  }
  return out;
}

const phase1 = { apps, auth, backups, schedules, siteSettings, account: { ...account, ...credentials, ...quotaAccount, ...notificationsAccount }, servers: { ...servers, ...network, ...quotaServers, ...notificationsServer }, files, content, subusers, domains, databases, admin: { ...admin, notifications: notificationsAdmin, users: { ...admin.users, ...quotaAdmin.users }, quotas: quotaAdmin.quotas, nodes: { ...admin.nodes, ...nodeMutations }, databaseHosts, dnsProviders, s3Targets } };

/** Paden die echt geïmplementeerd zijn (de rest is NOT_IMPLEMENTED). */
export function implementedPaths(tree: Tree = phase1 as unknown as Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === "function" ? [`${prefix}${k}`] : implementedPaths(v, `${prefix}${k}.`)));
}

export const implementation: Implementation = merge(notImplemented() as unknown as Tree, phase1 as unknown as Tree) as unknown as Implementation;
