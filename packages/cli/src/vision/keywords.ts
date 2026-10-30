/**
 * Keywords from what the vision model read: scene words from the caption and
 * the detector, plus the objects that occupy enough of the frame to matter.
 *
 * Replaces zero-shot CLIP scoring against a fixed list, which ranks every word
 * and keeps the top few — so it says *something* for every photograph, often
 * contradictory ("indoor" and "outdoor" on one frame). Here a word is written
 * only when the caption says it or the detector found it, and the two scene
 * words that exclude each other are decided between, never both.
 */
import type { VisionObject, VisionRecord } from './record.js';

/** Scene keyword → caption phrasings that state it. */
const SCENE: Record<string, RegExp> = {
  wedding: /\b(wedding|bride|groom|bridal)\b/,
  'group-photo': /\b(group of|crowd|several people|many people|family (photo|of)|posing together)\b/,
  landscape: /\b(landscape|countryside|valley|hills?|meadow|scenery)\b/,
  cityscape: /\b(city|skyline|cityscape|downtown)\b/,
  architecture: /\b(building|church|cathedral|tower|castle|bridge|architecture|facade|monument)\b/,
  street: /\b(street|sidewalk|road|alley|crosswalk)\b/,
  beach: /\b(beach|sand|shore)\b/,
  ocean: /\b(ocean|sea|waves)\b/,
  sunset: /\b(sunset|sunrise|golden hour|dusk)\b/,
  night: /\b(night|nighttime)\b/,
  snow: /\b(snow|snowy)\b/,
  forest: /\b(forest|woods)\b/,
  mountain: /\b(mountains?)\b/,
  flower: /\b(flowers?|bouquet|blossom)\b/,
  food: /\b(food|plate of|dish|meal|cake)\b/,
  pet: /\b(dog|cat|puppy|kitten)\b/,
  bird: /\b(bird|birds)\b/,
  car: /\b(car|cars)\b/,
  boat: /\b(boat|ship|sailboat)\b/,
  concert: /\b(concert|stage|microphone|band)\b/,
  sports: /\b(playing (soccer|football|tennis|basketball)|athlete|stadium)\b/,
};
const INDOOR = /\b(indoors?|inside|room|walls?|ceiling|couch|sofa|kitchen|bedroom|living room|table|window)\b/g;
const OUTDOOR = /\b(outdoors?|outside|sky|clouds?|grass|field|trees|street|garden|park|beach|mountains?|sun)\b/g;

/** Detector labels that name a part of something already named, or nothing a photographer files under. */
const DROP_OBJECTS = new Set(['human face', 'human head', 'human hair', 'human nose', 'human eye', 'human mouth', 'human ear', 'human hand', 'human arm', 'human leg', 'human body', 'clothing', 'footwear', 'fashion accessory', 'top']);
/** Detector labels written under a plainer name. */
const RENAME: Record<string, string> = { 'fancy dress': 'dress', 'land vehicle': 'vehicle', watercraft: 'boat' };
/** Labels that are a person: the subject of a portrait. */
const PERSON = new Set(['person', 'man', 'woman', 'boy', 'girl', 'child']);
/** Share of an object inside a person above which it is part of them (a print on a dress, glasses on a face). */
const WORN = 0.6;
/** An object must cover at least this share of the frame to be a keyword rather than background. */
const MIN_OBJECT_AREA = 0.02;
const MAX_KEYWORDS = 10;

const area = (o: VisionObject): number => Math.max(0, o.box[2] - o.box[0]) * Math.max(0, o.box[3] - o.box[1]);
const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
/** Share of `o`'s box that lies inside `p`'s. */
function inside(o: VisionObject, p: VisionObject): number {
  const w = Math.max(0, Math.min(o.box[2], p.box[2]) - Math.max(o.box[0], p.box[0]));
  const h = Math.max(0, Math.min(o.box[3], p.box[3]) - Math.max(o.box[1], p.box[1]));
  return area(o) ? (w * h) / area(o) : 0;
}

export function keywordsFromVision(record: VisionRecord): string[] {
  const caption = record.caption.toLowerCase();
  const people = record.objects.filter((o) => PERSON.has(o.label.toLowerCase()));
  const faces = record.objects.filter((o) => o.label.toLowerCase() === 'human face');
  const out: string[] = [];

  // Portrait: a person who fills the frame, a large face, or a caption that says so.
  // The detector often names the person (girl, man) without a separate face.
  const portraitCaption = /\b(portrait|close-up|looking (directly )?(at|into) the camera|posing for)\b/.test(caption);
  if (people.length && (portraitCaption || faces.some((f) => area(f) > 0.03) || people.some((p) => area(p) > 0.2))) out.push('portrait');
  for (const [word, re] of Object.entries(SCENE)) {
    if (re.test(caption)) out.push(word);
  }
  // Indoor or outdoor, decided by which the caption describes more; neither when it is silent.
  const indoor = count(caption, INDOOR);
  const outdoor = count(caption, OUTDOOR);
  if (indoor > outdoor) out.push('indoor');
  else if (outdoor > indoor) out.push('outdoor');

  for (const o of record.objects) {
    const raw = o.label.toLowerCase();
    if (DROP_OBJECTS.has(raw) || area(o) < MIN_OBJECT_AREA) continue;
    // Worn by someone in the frame — a floral print, a pair of glasses — not a subject of its own.
    if (!PERSON.has(raw) && people.some((p) => p !== o && inside(o, p) > WORN)) continue;
    const label = RENAME[raw] ?? raw;
    if (!out.includes(label)) out.push(label);
  }
  // A flower the caption mentions only as a pattern ("a dress with flowers on it") is not a flower photograph.
  if (out.includes('flower') && !record.objects.some((o) => o.label.toLowerCase() === 'flower' && !people.some((p) => inside(o, p) > WORN))) {
    out.splice(out.indexOf('flower'), 1);
  }
  return out.slice(0, MAX_KEYWORDS);
}
