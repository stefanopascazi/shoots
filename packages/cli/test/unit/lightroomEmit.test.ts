import { describe, expect, test } from 'bun:test';
import { lightroomSettings, lookFromXml } from '../../src/develop/adapters/lightroom/emit.js';
import { CURVE_KNOTS, curveParamKey } from '../../src/develop/develop/schema.js';

// As a sidecar stores Adobe Color, and as `getDevelopSettings()` returned it in the field test.
const ADOBE_COLOR_XML = `<crs:Look>
    <rdf:Description
     crs:Name="Adobe Color"
     crs:Amount="1"
     crs:UUID="B952C231111CD8E0ECCF14B86BAA7077"
     crs:SupportsAmount="false"
     crs:SupportsMonochrome="false"
     crs:SupportsOutputReferred="false">
    <crs:Group>
     <rdf:Alt>
      <rdf:li xml:lang="x-default">Profiles</rdf:li>
     </rdf:Alt>
    </crs:Group>
    <crs:Parameters>
     <rdf:Description
      crs:Version="15.5"
      crs:ProcessVersion="15.4"
      crs:ConvertToGrayscale="False"
      crs:CameraProfile="Adobe Standard"
      crs:LookTable="E1095149FDB39D7A057BAB208837E2E1">
     <crs:ToneCurvePV2012>
      <rdf:Seq>
       <rdf:li>0, 0</rdf:li>
       <rdf:li>22, 16</rdf:li>
       <rdf:li>40, 35</rdf:li>
       <rdf:li>127, 127</rdf:li>
       <rdf:li>224, 230</rdf:li>
       <rdf:li>240, 246</rdf:li>
       <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
     </crs:ToneCurvePV2012>
     <crs:ToneCurvePV2012Red>
      <rdf:Seq>
       <rdf:li>0, 0</rdf:li>
       <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
     </crs:ToneCurvePV2012Red>
     </rdf:Description>
    </crs:Parameters>
    </rdf:Description>
   </crs:Look>`;

const SDK_ADOBE_COLOR = {
  Amount: 1,
  Group: { 'x-default': 'Profiles' },
  Name: 'Adobe Color',
  Parameters: {
    CameraProfile: 'Adobe Standard',
    ConvertToGrayscale: false,
    LookTable: 'E1095149FDB39D7A057BAB208837E2E1',
    ProcessVersion: '15.4',
    ToneCurvePV2012: [0, 0, 22, 16, 40, 35, 127, 127, 224, 230, 240, 246, 255, 255],
    ToneCurvePV2012Red: [0, 0, 255, 255],
    Version: '15.5',
  },
  SupportsAmount: false,
  SupportsMonochrome: false,
  SupportsOutputReferred: false,
  UUID: 'B952C231111CD8E0ECCF14B86BAA7077',
};

describe('lookFromXml', () => {
  test('a sidecar Look becomes the table the SDK returns', () => {
    expect(lookFromXml(ADOBE_COLOR_XML)).toEqual(SDK_ADOBE_COLOR);
  });

  test('no name, no Look', () => {
    expect(lookFromXml('<crs:Look><rdf:Description crs:Amount="1"/></crs:Look>')).toBeUndefined();
  });
});

describe('lightroomSettings', () => {
  const linear = Object.fromEntries(CURVE_KNOTS.map((k) => [curveParamKey(k), k]));

  test('sliders rounded as Lightroom stores them, WB custom only with a temperature', () => {
    const s = lightroomSettings({ Exposure2012: 0.456, Contrast2012: 12.6, Temperature: 5230.4, Tint: 3.2 }, 'color');
    expect(s).toMatchObject({ Exposure2012: 0.46, Contrast2012: 13, Temperature: 5230, Tint: 3, WhiteBalance: 'Custom', ConvertToGrayscale: false });
    expect(lightroomSettings({ Exposure2012: 0 }, 'color').WhiteBalance).toBeUndefined();
  });

  test('the curve is always stated: linear when the prediction keeps it straight', () => {
    const flat = lightroomSettings({ ...linear }, 'color');
    expect(flat.ToneCurveName2012).toBe('Linear');
    expect(flat.ToneCurvePV2012).toEqual([0, 0, 255, 255]);
    expect(Object.keys(flat).some((k) => k.startsWith('ToneCurvePoint'))).toBe(false);

    const lifted = lightroomSettings({ ...linear, [curveParamKey(CURVE_KNOTS[0]!)]: 20 }, 'color');
    expect(lifted.ToneCurveName2012).toBe('Custom');
    expect((lifted.ToneCurvePV2012 as number[]).slice(0, 2)).toEqual([CURVE_KNOTS[0], 20]);
    expect(lifted.ToneCurvePV2012Red).toEqual([0, 0, 255, 255]);
  });

  test('black and white, the base profile and the Look travel with it', () => {
    const s = lightroomSettings({}, 'bw', { profile: 'Adobe Standard v2', look: 'Adobe Color', lookXml: ADOBE_COLOR_XML });
    expect(s.ConvertToGrayscale).toBe(true);
    expect(s.CameraProfile).toBe('Adobe Standard v2');
    expect(s.Look).toEqual(SDK_ADOBE_COLOR);
  });
});
