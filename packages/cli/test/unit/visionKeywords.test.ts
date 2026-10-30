import { describe, expect, test } from 'bun:test';
import { keywordsFromVision } from '../../src/vision/keywords.js';
import type { VisionObject, VisionRecord } from '../../src/vision/record.js';

const obj = (label: string, box: VisionObject['box']): VisionObject => ({ label, box });
const record = (caption: string, objects: VisionObject[] = []): VisionRecord => ({ caption, objects, regions: {} });

describe('keywordsFromVision', () => {
  test('scene words come from the caption, objects from the detector', () => {
    expect(keywordsFromVision(record('A woman sitting on a bench at the beach. The sky is blue.', [obj('woman', [0.3, 0.1, 0.6, 0.9])]))).toEqual([
      'portrait',
      'beach',
      'outdoor',
      'woman',
    ]);
  });

  test('indoor and outdoor are decided between, never both; a tie says neither', () => {
    expect(keywordsFromVision(record('A man sitting on a couch in a room near a window.'))).toContain('indoor');
    const tie = keywordsFromVision(record('A man in a room full of trees.'));
    expect(tie.filter((w) => w === 'indoor' || w === 'outdoor')).toHaveLength(0);
  });

  test('a print on a dress is not a flower photograph', () => {
    const girl = obj('girl', [0.2, 0.1, 0.8, 1]);
    const k = keywordsFromVision(record('A girl wearing a white dress with black flowers on it.', [girl, obj('flower', [0.4, 0.6, 0.5, 0.7])]));
    expect(k).not.toContain('flower');
    expect(k).toContain('girl');
  });

  test('a flower the photograph is about stays', () => {
    expect(keywordsFromVision(record('A bunch of white flowers in a field.', [obj('flower', [0.1, 0.1, 0.9, 0.9])]))).toContain('flower');
  });

  test('detector names are made plain, small background objects and body parts dropped', () => {
    const k = keywordsFromVision(
      record('A van parked at night.', [obj('land vehicle', [0.1, 0.2, 0.9, 0.9]), obj('human face', [0.5, 0.5, 0.6, 0.6]), obj('bottle', [0.01, 0.01, 0.03, 0.03])]),
    );
    expect(k).toContain('vehicle');
    expect(k).not.toContain('human face');
    expect(k).not.toContain('bottle');
  });

  test('a person far in the background does not make a portrait', () => {
    expect(keywordsFromVision(record('A street with tall buildings.', [obj('person', [0.45, 0.5, 0.5, 0.6])]))).not.toContain('portrait');
  });
});
