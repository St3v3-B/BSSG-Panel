/**
 * Test-login (alleen met PANEL_INSECURE_TEST_LOGIN=1 én PANEL_DOMAIN op .test, anders 404).
 * POST {discordId, name} → sessie zoals na een Discord-login.
 */
import { testLogin } from "@/server/test-login";

export const dynamic = "force-dynamic";
export const POST = testLogin;
