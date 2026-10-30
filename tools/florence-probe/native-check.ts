// Native Florence (packages/inference) against the transformers.js wrapper, same photographs.
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { closeExiftoolDaemon } from '@shoots/imaging';
import { loadFlorence as loadNative } from '../../packages/inference/src/florence/model.js';
import { loadFlorence as loadRef, loadUpright } from './florence.js';
const files = process.argv.slice(2);
const native = await loadNative(path.join(os.homedir(), '.shoots/models/florence-2-base-ft'));
const ref = await loadRef('fp32', 'cpu');
for (const f of files) {
  const { image, jpeg } = await loadUpright(f);
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let t = performance.now();
  const seen = await native.see(new Uint8Array(data), info.width, info.height);
  const cap = await native.caption(seen);
  const g = await native.ground(seen, ['sky', 'person', 'face']);
  const tn = performance.now() - t;
  t = performance.now();
  const rcap = await ref.caption(image);
  const rg = await ref.ground(image, ['sky', 'person', 'face']);
  const tr = performance.now() - t;
  console.log(path.basename(f), `native ${Math.round(tn)}ms ref ${Math.round(tr)}ms`);
  console.log('  native:', cap.slice(0, 140));
  console.log('  ref   :', rcap.trim().slice(0, 140));
  console.log('  ground native', JSON.stringify(g.labels), 'ref', JSON.stringify(rg.labels));
}
await closeExiftoolDaemon();
