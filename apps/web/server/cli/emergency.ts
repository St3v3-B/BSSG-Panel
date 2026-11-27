/**
 * Stelt het noodaccount in (wachtwoord + TOTP). Draait in de panel-container met de omgeving van
 * panel.env:   deploy/install.sh --set-emergency-password
 * of in de repo: pnpm --filter @panel/web exec tsx server/cli/emergency.ts
 *
 * Het wachtwoord komt van stdin (zonder echo op een terminal) of uit EMERGENCY_PASSWORD. Het
 * TOTP-secret en de QR-code worden maar één keer getoond.
 */
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { closeDb } from "../db";
import { EMERGENCY_MIN_PASSWORD, setEmergencyCredentials } from "../emergency";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (l) => (rl.close(), resolve(l)));
      rl.once("close", () => resolve(""));
      return;
    }
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  let password = process.env.EMERGENCY_PASSWORD;
  if (!password) {
    password = await readHidden(`New emergency password (min ${EMERGENCY_MIN_PASSWORD} chars): `);
    if (process.stdin.isTTY) {
      const again = await readHidden("Repeat password: ");
      if (again !== password) throw new Error("passwords do not match");
    }
  }
  const r = await setEmergencyCredentials(password);
  const qr = await QRCode.toString(r.otpauthUrl, { type: "terminal", small: true });
  console.log(`\nEmergency account ${r.created ? "created" : "updated"}. Scan this QR code with your authenticator app NOW; it is shown only once.\n`);
  console.log(qr);
  console.log(`Secret (manual entry): ${r.secret}`);
  console.log(`URL: ${r.otpauthUrl}\n`);
  console.log("Log in via the 'Emergency login' link on the login page. Every use is logged and shown on the admin dashboard.");
}

main()
  .catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
