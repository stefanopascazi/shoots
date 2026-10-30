// Load Florence from a provisioned install dir and caption one photograph.
import sharp from 'sharp';
import { closeExiftoolDaemon } from '@shoots/imaging';
import { loadFlorence } from '../../packages/inference/src/florence/model.js';
import { loadUpright } from './florence.js';
const [dir, file] = process.argv.slice(2);
const fl = await loadFlorence(dir!);
const { jpeg } = await loadUpright(file!);
await closeExiftoolDaemon();
const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const img = await fl.see(new Uint8Array(data), info.width, info.height);
console.log(await fl.caption(img));
console.log(JSON.stringify((await fl.detect(img)).labels));
