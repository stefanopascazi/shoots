// Compare our tokenizer with transformers.js on the prompts Shoots uses.
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { createTokenizer } from '../../packages/inference/src/florence/tokenizer.js';
env.localModelPath = path.join(os.homedir(), '.shoots', 'models');
env.allowRemoteModels = false;
const dir = path.join(os.homedir(), '.shoots/models/florence-2-base-ft');
const ours = createTokenizer(JSON.parse(readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')));
const ref = await AutoTokenizer.from_pretrained('florence-2-base-ft');
const texts = ['Describe with a paragraph what is shown in the image.', 'Locate the objects with category name in the image.',
  'Locate the phrases in the caption: sky. person. face. trees. water. building.', 'Locate the sky in the image with mask', "A woman's café, 2026 — naïve!"];
let ok = true;
for (const t of texts) {
  const a = ours.encode(t);
  const b = Array.from(ref(t).input_ids.data as BigInt64Array, Number);
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok &&= same;
  console.log(same ? 'OK ' : 'DIFF', t, same ? '' : `\n  ours ${a}\n  ref  ${b}`);
  const back = ours.decode(a);
  console.log('   decode:', back);
}
const locIds = [ours.encode('x')[0]!, 50269, 51000, ours.eos];
console.log('special decode:', ours.decode(locIds), 'vs', ref.decode(locIds, { skip_special_tokens: false }));
process.exit(ok ? 0 : 1);
