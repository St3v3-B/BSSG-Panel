import sharp from "sharp";
import fs from "fs";
const svg = fs.readFileSync(new URL("../apps/web/public/brand/logo-mark.svg", import.meta.url));
const png = await sharp(svg, { density: 576 }).resize(64, 64).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(new URL("../daemon/internal/mcproto/server-icon.png", import.meta.url), png);
console.log(png.length);
