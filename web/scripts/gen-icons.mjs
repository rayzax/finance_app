// Generates the favicon and PNG icons: a gold mountain-ridge line on pine-black.
// Usage: npm run icons   (outputs are committed into public/)
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#0C1411"/>
<path d="M92 372 L168 276 L216 316 L290 204 L350 288 L398 236 L420 262" fill="none" stroke="#C9A86A" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M92 420 L150 384 L214 410 L272 348 L330 392 L420 336" fill="none" stroke="#C9A86A" stroke-opacity="0.4" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(path.join(out, 'favicon.svg'), svg);
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toFile(path.join(out, name));
}
console.log('icons written to', out);
