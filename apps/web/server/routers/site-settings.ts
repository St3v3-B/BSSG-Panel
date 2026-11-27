/** siteSettings.*: PHP settings of PHP websites (managed ini + nginx include via the daemon file API). */
import type { Implementation, PhpSettings } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { logActivity } from "../activity";
import { call, daemonFor } from "../daemon";
import { PHP_DEFAULTS, PHP_EXTENSIONS, DISABLED_EXT_PATH, NGINX_CONF_PATH, PHP_INI_PATH, parseDisabledExtensions, parsePhpIni, renderDisabledExtensions, renderNginxConf, renderPhpIni, validTimezone } from "../lib/php-settings";
import { limitsOf, requireServer, serverVariables, type ServerBundle } from "../servers-data";
import { setVariables } from "./network";

const ok = { ok: true as const };
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

async function phpAccess(ctx: Parameters<typeof requireServer>[0], uuid: string, mutates: boolean) {
  const a = await requireServer(ctx, uuid, "owner", { mutates });
  if (a.bundle.server.type !== "web" || !a.bundle.template.slug.startsWith("php-")) throw bad("NOT_PHP_SITE");
  return a;
}

async function readOptional(b: ServerBundle, path: string): Promise<string | null> {
  try {
    return await call(() => daemonFor(b.node).readFile(b.server.uuid, path));
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

const mbOf = (v: string | undefined, d: number) => {
  const m = /^(\d+)M$/.exec(v ?? "");
  return m ? Number(m[1]) : d;
};

async function defaultsFor(b: ServerBundle): Promise<PhpSettings> {
  const vars = await serverVariables(b.server.id);
  const tplDefault = (k: string) => b.template.variables.find((v) => v.key === k)?.default;
  return {
    ...PHP_DEFAULTS,
    memoryLimitMb: mbOf(vars.PHP_MEMORY_LIMIT ?? tplDefault("PHP_MEMORY_LIMIT"), PHP_DEFAULTS.memoryLimitMb),
    uploadMaxMb: mbOf(vars.UPLOAD_MAX_SIZE ?? tplDefault("UPLOAD_MAX_SIZE"), PHP_DEFAULTS.uploadMaxMb),
  };
}

async function isRunning(b: ServerBundle): Promise<boolean> {
  try {
    const st = await daemonFor(b.node).getServer(b.server.uuid, 2000);
    return st.state === "online" || st.state === "starting";
  } catch {
    return false;
  }
}

export const siteSettings: Implementation["siteSettings"] = {
  php: async ({ input, ctx }) => {
    const { bundle: b } = await phpAccess(ctx, input.uuid, false);
    const defaults = await defaultsFor(b);
    const ini = await readOptional(b, PHP_INI_PATH);
    const disabled = await readOptional(b, DISABLED_EXT_PATH);
    const settings = { ...(ini === null ? defaults : parsePhpIni(ini, defaults)), disabledExtensions: parseDisabledExtensions(disabled ?? "") };
    return { settings, defaults, managed: ini !== null, ramLimitMb: limitsOf(b.server).ramMb, extensions: [...PHP_EXTENSIONS] };
  },

  updatePhp: async ({ input, ctx }) => {
    const { bundle: b } = await phpAccess(ctx, input.uuid, true);
    const s = input.settings;
    if (s.memoryLimitMb > limitsOf(b.server).ramMb) throw bad("MEMORY_EXCEEDS_RAM");
    if (!validTimezone(s.timezone)) throw bad("INVALID_TIMEZONE");
    s.disabledExtensions = PHP_EXTENSIONS.filter((e) => s.disabledExtensions.includes(e));
    const node = daemonFor(b.node);
    const uuid = b.server.uuid;
    for (const d of ["/php", "/nginx"]) await call(() => node.mkdir(uuid, d)).catch(() => undefined);
    await call(() => node.writeFile(uuid, PHP_INI_PATH, renderPhpIni(s)));
    await call(() => node.writeFile(uuid, NGINX_CONF_PATH, renderNginxConf(s)));
    await call(() => node.writeFile(uuid, DISABLED_EXT_PATH, renderDisabledExtensions(s)));
    // Keep the template variables in line and refresh the daemon spec (startup of the current template version).
    await setVariables(b, { PHP_MEMORY_LIMIT: `${s.memoryLimitMb}M`, UPLOAD_MAX_SIZE: `${s.uploadMaxMb}M` });
    const restarted = await isRunning(b);
    if (restarted) await call(() => node.power(uuid, "restart"));
    await logActivity({ action: "server.php.update", userId: ctx.session!.userId, serverId: b.server.id, metadata: { ...s, restarted }, ip: ctx.ip, ctx });
    return ok;
  },
};
