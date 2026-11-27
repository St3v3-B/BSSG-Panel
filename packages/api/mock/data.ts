/** Voorbeelddata voor de mock. Domeinen altijd *.test (zie CLAUDE.md). */
import type * as s from "../schemas";

const d = (iso: string) => new Date(iso);

export const users: s.UserPublic[] = [
  { id: 1, discordId: "100000000000000001", name: "steve", avatarUrl: null },
  { id: 2, discordId: "100000000000000002", name: "blokgenoot", avatarUrl: null },
  { id: 3, discordId: "100000000000000003", name: null, avatarUrl: null }, // vooraf aangemaakt, nog niet ingelogd
];

export const nodes: s.Node[] = [
  { id: 1, name: "node1", fqdn: "node1.test", daemonPort: 8080, sftpPort: 2022, maxRamMb: 6144, maxDiskMb: 200_000, s3TargetId: 1, diskQuotaMode: "soft", isLocal: true },
];

export const templates: s.TemplateDetail[] = [
  {
    id: 1,
    slug: "paper",
    name: "Paper",
    type: "game",
    version: 1,
    description: "Paper Minecraft server",
    serverCount: 2,
    yaml: "schema: 1\nslug: paper\n# zie templates/game/paper.yaml\n",
    variables: [
      { key: "MINECRAFT_VERSION", name: "Minecraft version", description: "e.g. 1.21.4 or latest", default: "latest", userEditable: true, pattern: "^(latest|\\d+\\.\\d+(\\.\\d+)?)$" },
    ],
  },
  { id: 2, slug: "static", name: "Static site", type: "web", version: 1, description: "nginx", serverCount: 1, yaml: "schema: 1\nslug: static\n", variables: [] },
];

export const allocations: s.Allocation[] = [
  { id: 1, nodeId: 1, ip: "203.0.113.10", port: 25565, serverUuid: "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6", primary: true },
  { id: 2, nodeId: 1, ip: "203.0.113.10", port: 25566, serverUuid: "3a1d9b7c-5e6f-4a8b-9c0d-112233445566", primary: true },
  { id: 3, nodeId: 1, ip: "203.0.113.10", port: 25567, serverUuid: null, primary: false },
  { id: 4, nodeId: 1, ip: "203.0.113.10", port: 25568, serverUuid: null, primary: false },
];

const limits = { cpuPct: 200, ramMb: 4096, swapMb: 0, diskMb: 20_000 };

export const servers: (s.ServerDetail & { ownerId: number })[] = [
  {
    uuid: "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6",
    shortId: "8f6c1a2e",
    name: "SMP",
    type: "game",
    status: "online",
    templateName: "Paper",
    nodeName: "node1",
    primaryAddress: "203.0.113.10:25565",
    limits,
    isOwner: true,
    owner: users[0]!,
    ownerId: 1,
    permissions: [],
    allocations: [allocations[0]!],
    variables: [{ key: "MINECRAFT_VERSION", name: "Minecraft version", description: null, value: "1.21.4", default: "latest", userEditable: true, pattern: null }],
    node: { id: 1, name: "node1", fqdn: "node1.test" },
    sftp: { host: "node1.test", port: 2022, username: "steve.8f6c1a2e" },
    suspended: null,
    network: { role: "none", members: [], proxy: null, connectAddress: null },
    domainsAllowed: false,
    sleep: { supported: true, enabled: true, idleMinutes: 10 },
    installedAt: d("2026-11-20T10:00:00Z"),
    createdAt: d("2026-11-20T09:58:00Z"),
  },
  {
    uuid: "3a1d9b7c-5e6f-4a8b-9c0d-112233445566",
    shortId: "3a1d9b7c",
    name: "Creative",
    type: "game",
    status: "offline",
    templateName: "Paper",
    nodeName: "node1",
    primaryAddress: "203.0.113.10:25566",
    limits: { ...limits, ramMb: 2048 },
    isOwner: false,
    owner: users[1]!,
    ownerId: 2,
    permissions: [],
    allocations: [allocations[1]!],
    variables: [],
    node: { id: 1, name: "node1", fqdn: "node1.test" },
    sftp: { host: "node1.test", port: 2022, username: "steve.3a1d9b7c" },
    suspended: null,
    network: { role: "none", members: [], proxy: null, connectAddress: null },
    domainsAllowed: false,
    sleep: { supported: true, enabled: false, idleMinutes: 10 },
    installedAt: d("2026-11-21T10:00:00Z"),
    createdAt: d("2026-11-21T09:58:00Z"),
  },
  {
    uuid: "c0ffee00-1234-4abc-8def-0123456789ab",
    shortId: "c0ffee00",
    name: "blokgenoten.test",
    type: "web",
    status: "installing",
    templateName: "Static site",
    nodeName: "node1",
    primaryAddress: "blokgenoten.test",
    limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 2000 },
    isOwner: true,
    owner: users[0]!,
    ownerId: 1,
    permissions: [],
    allocations: [],
    variables: [],
    node: { id: 1, name: "node1", fqdn: "node1.test" },
    sftp: { host: "node1.test", port: 2022, username: "steve.c0ffee00" },
    suspended: null,
    network: { role: "none", members: [], proxy: null, connectAddress: null },
    domainsAllowed: false,
    sleep: { supported: false, enabled: false, idleMinutes: 10 },
    installedAt: null,
    createdAt: d("2026-11-25T09:58:00Z"),
  },
];

export const domains: s.Domain[] = [
  { id: 1, serverUuid: "c0ffee00-1234-4abc-8def-0123456789ab", hostname: "blokgenoten.test", protocol: "http", targetPort: null, redirectTo: null, wildcard: false, dnsProviderId: null, sslStatus: "pending", dnsStatus: "missing", lastCheckedAt: d("2026-11-25T10:00:00Z") },
  { id: 2, serverUuid: "c0ffee00-1234-4abc-8def-0123456789ab", hostname: "www.blokgenoten.test", protocol: "http", targetPort: null, redirectTo: "blokgenoten.test", wildcard: false, dnsProviderId: null, sslStatus: "pending", dnsStatus: "missing", lastCheckedAt: null },
];

export const files: s.FileEntry[] = [
  { name: "plugins", path: "/plugins", isDirectory: true, isSymlink: false, size: 4096, mode: "drwxr-xr-x", mimeType: "inode/directory", modifiedAt: d("2026-11-24T12:00:00Z") },
  { name: "world", path: "/world", isDirectory: true, isSymlink: false, size: 4096, mode: "drwxr-xr-x", mimeType: "inode/directory", modifiedAt: d("2026-11-26T03:00:00Z") },
  { name: "server.properties", path: "/server.properties", isDirectory: false, isSymlink: false, size: 1432, mode: "-rw-r--r--", mimeType: "text/plain", modifiedAt: d("2026-11-24T12:00:00Z") },
  { name: "server.jar", path: "/server.jar", isDirectory: false, isSymlink: false, size: 48_000_000, mode: "-rw-r--r--", mimeType: "application/java-archive", modifiedAt: d("2026-11-20T10:00:00Z") },
];

export const fileContents: Record<string, string> = {
  "/server.properties": "motd=Blokgenoten SMP\nserver-port=25565\nmax-players=20\nonline-mode=true\n",
};

export const backups: s.Backup[] = [
  { id: 1, serverUuid: "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6", name: "daily 2026-11-26", sizeBytes: 812_000_000, sha256: "a".repeat(64), status: "completed", includesDatabases: false, createdAt: d("2026-11-26T03:00:00Z"), completedAt: d("2026-11-26T03:04:10Z") },
];

export const schedules: s.Schedule[] = [
  { id: 1, serverUuid: "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6", name: "Daily restart", cron: "0 5 * * *", action: "restart", payload: null, active: true, lastRunAt: d("2026-11-26T04:00:00Z"), nextRunAt: d("2026-11-27T04:00:00Z"), lastResult: "ok", lastOutput: null },
];

export const activity: s.ActivityEntry[] = [
  { id: 3, action: "server.power.start", user: users[0]!, serverUuid: servers[0]!.uuid, serverName: "SMP", metadata: {}, ip: "198.51.100.7", at: d("2026-11-26T08:01:00Z") },
  { id: 2, action: "admin.server.create", user: users[0]!, serverUuid: servers[1]!.uuid, serverName: "Creative", metadata: { template: "paper" }, ip: "198.51.100.7", at: d("2026-11-21T09:58:00Z") },
  { id: 1, action: "auth.login", user: users[0]!, serverUuid: null, serverName: null, metadata: { method: "discord" }, ip: "198.51.100.7", at: d("2026-11-20T09:00:00Z") },
];
