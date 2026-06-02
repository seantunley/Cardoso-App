// One-off: take the supplied Cardoso Depots PNG (dark logo on cream
// background, no alpha) and produce an orange-on-transparent version
// used in the sidebar header.
//
// "Dark pixel" detection is a simple brightness threshold — the source
// logo is essentially binary (cream background, near-black ink) so a
// midpoint threshold cleanly separates the two.
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";

const SRC = "docs/images/Cardoso.png";
const OUT = "public/cardoso-logo-orange.png";
const ORANGE = [249, 115, 22]; // tailwind orange-500 (#f97316)
const DARK_THRESHOLD = 140;     // pixels with avg(r,g,b) below this become orange

const buf = await fs.readFile(SRC);
const { data, info } = await sharp(buf)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const channels = info.channels;            // RGBA = 4
const out = Buffer.alloc(info.width * info.height * 4);

for (let i = 0, j = 0; i < data.length; i += channels, j += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const brightness = (r + g + b) / 3;
  if (brightness < DARK_THRESHOLD) {
    out[j]     = ORANGE[0];
    out[j + 1] = ORANGE[1];
    out[j + 2] = ORANGE[2];
    out[j + 3] = 255;
  } else {
    // Background → fully transparent (we keep RGB zeros for cleanliness)
    out[j] = 0; out[j + 1] = 0; out[j + 2] = 0; out[j + 3] = 0;
  }
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png()
  .toFile(OUT);

console.log(`Wrote ${OUT} (${info.width}×${info.height})`);
