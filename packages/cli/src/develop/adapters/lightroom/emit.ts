/**
 * A prediction as Lightroom Classic's `photo:applyDevelopSettings()` takes it —
 * the inverse of catalog.ts. The SDK names settings after the crs properties,
 * carries the tone curve as a flat `{x, y, …}` list and the creative profile as
 * a `Look` table, exactly as `getDevelopSettings()` returned them for training.
 */
import { CURVE_KNOTS, curveFromDevelop, curveParamKey, type Treatment } from '../../develop/schema.js';
import type { PredictedEdit } from '../types.js';

/** A value applyDevelopSettings accepts: scalars, flat number lists, nested tables (the Look). */
export type LightroomValue = number | string | boolean | number[] | { [key: string]: LightroomValue };
export type LightroomSettings = Record<string, LightroomValue>;

const CURVE_KEYS = new Set(CURVE_KNOTS.map(curveParamKey));
const LINEAR = [0, 0, 255, 255];

/** Exposure in stops keeps two decimals; every other slider is whole. */
function round(key: string, value: number): number {
  return key === 'Exposure2012' ? Math.round(value * 100) / 100 : Math.round(value);
}

const attributes = (xml: string): Record<string, string> =>
  Object.fromEntries([...xml.matchAll(/crs:(\w+)="([^"]*)"/g)].map((m) => [m[1]!, unescape(m[2]!)]));

function unescape(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Identifiers and versions stay strings even when they look like numbers.
const TEXT = new Set(['Name', 'UUID', 'Version', 'ProcessVersion', 'CameraProfile', 'LookTable', 'ToneCurveName2012']);

function typed(key: string, v: string): LightroomValue {
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (!TEXT.has(key) && /^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function typedAll(attrs: Record<string, string>): Record<string, LightroomValue> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, typed(k, v)]));
}

/** Every `<crs:X><rdf:Seq><rdf:li>x, y</rdf:li>…` curve inside `xml`, flattened. */
function curves(xml: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const m of xml.matchAll(/<crs:(ToneCurve\w*)>\s*<rdf:Seq>([\s\S]*?)<\/rdf:Seq>/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/<rdf:li>\s*(\d+)\s*,\s*(\d+)\s*<\/rdf:li>/g)].flatMap((p) => [Number(p[1]), Number(p[2])]);
  }
  return out;
}

/**
 * A captured `<crs:Look>` element as the SDK's `Look` table: the look's own
 * attributes, `Group` by language, and `Parameters` with its tone curves.
 */
export function lookFromXml(xml: string): LightroomSettings | undefined {
  const params = /<crs:Parameters>([\s\S]*?)<\/crs:Parameters>/.exec(xml)?.[1];
  const head = (params === undefined ? xml : xml.slice(0, xml.indexOf('<crs:Parameters>'))).replace(/<crs:Group>[\s\S]*?<\/crs:Group>/, '');
  const look: LightroomSettings = typedAll(attributes(head));
  if (typeof look.Name !== 'string') return undefined;
  const group = /<crs:Group>[\s\S]*?<rdf:li xml:lang="([^"]+)">([^<]*)<\/rdf:li>/.exec(xml);
  if (group) look.Group = { [group[1]!]: unescape(group[2]!) };
  if (params !== undefined) {
    const own = params.replace(/<crs:ToneCurve\w*>[\s\S]*?<\/crs:ToneCurve\w*>/g, '');
    look.Parameters = { ...typedAll(attributes(own)), ...curves(params) };
  }
  return look;
}

/** One prediction as the settings table the plug-in hands to applyDevelopSettings. */
export function lightroomSettings(
  develop: Record<string, number>,
  treatment: Treatment,
  render?: PredictedEdit['render'],
): LightroomSettings {
  const out: LightroomSettings = {};
  for (const [key, value] of Object.entries(develop)) {
    if (!CURVE_KEYS.has(key) && Number.isFinite(value)) out[key] = round(key, value);
  }
  // Always stated: applying merges into what the photo has, and a curve left
  // from an earlier edit would sit under the predicted sliders.
  const curve = curveFromDevelop(develop);
  out.ToneCurveName2012 = curve ? 'Custom' : 'Linear';
  out.ToneCurvePV2012 = curve ?? LINEAR;
  out.ToneCurvePV2012Red = LINEAR;
  out.ToneCurvePV2012Green = LINEAR;
  out.ToneCurvePV2012Blue = LINEAR;
  // An absolute Kelvin only holds under a custom white balance; without one
  // the prediction kept the camera's, and As Shot stays.
  if ('Temperature' in out) out.WhiteBalance = 'Custom';
  out.ConvertToGrayscale = treatment === 'bw';
  if (render?.profile) out.CameraProfile = render.profile;
  const look = render?.lookXml ? lookFromXml(render.lookXml) : undefined;
  if (look) out.Look = look;
  return out;
}
