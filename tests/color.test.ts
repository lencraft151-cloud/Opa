import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampMirek,
  hsvToRgb,
  hsvToXy,
  kelvinToMired,
  miredToKelvin,
  rgbToHsv,
  rgbToXy,
  xyToHsv,
  xyToRgb,
} from '../src/core/color.ts';

describe('Farbraum-Umrechnung', () => {
  it('wandelt HSV in RGB für die Primärfarben', () => {
    assert.deepEqual(hsvToRgb(0, 100, 100), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hsvToRgb(120, 100, 100), { r: 0, g: 255, b: 0 });
    assert.deepEqual(hsvToRgb(240, 100, 100), { r: 0, g: 0, b: 255 });
    assert.deepEqual(hsvToRgb(0, 0, 100), { r: 255, g: 255, b: 255 });
  });

  it('ist bei HSV → RGB → HSV verlustarm', () => {
    for (const hue of [0, 45, 137, 210, 300, 359]) {
      const rgb = hsvToRgb(hue, 90, 100);
      const back = rgbToHsv(rgb);
      assert.ok(Math.abs(back.hue - hue) < 1.5, `Farbton ${hue} → ${back.hue}`);
      assert.ok(Math.abs(back.saturation - 90) < 1.5, `Sättigung ${back.saturation}`);
    }
  });

  it('normalisiert Farbtöne außerhalb von 0..360', () => {
    assert.deepEqual(hsvToRgb(360, 100, 100), hsvToRgb(0, 100, 100));
    assert.deepEqual(hsvToRgb(-120, 100, 100), hsvToRgb(240, 100, 100));
  });

  it('liefert xy-Werte innerhalb des CIE-Dreiecks', () => {
    for (const rgb of [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 128, g: 200, b: 30 },
    ]) {
      const xy = rgbToXy(rgb);
      assert.ok(xy.x >= 0 && xy.x <= 1, `x=${xy.x}`);
      assert.ok(xy.y >= 0 && xy.y <= 1, `y=${xy.y}`);
      assert.ok(xy.x + xy.y <= 1.001, `x+y=${xy.x + xy.y}`);
    }
  });

  it('bildet Schwarz auf den D65-Weißpunkt ab statt auf NaN', () => {
    const xy = rgbToXy({ r: 0, g: 0, b: 0 });
    assert.ok(Number.isFinite(xy.x) && Number.isFinite(xy.y));
  });

  it('erhält den Farbton über den Umweg xy (Hue-Bridge-Format)', () => {
    for (const hue of [10, 100, 200, 280]) {
      const back = xyToHsv(hsvToXy(hue, 100));
      const distance = Math.min(Math.abs(back.hue - hue), 360 - Math.abs(back.hue - hue));
      assert.ok(distance < 20, `Farbton ${hue} → ${back.hue}`);
    }
  });

  it('begrenzt RGB-Werte aus xy auf 0..255', () => {
    const rgb = xyToRgb({ x: 0.7, y: 0.29 }, 1);
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      assert.ok(channel >= 0 && channel <= 255, `Kanal ${channel}`);
    }
  });

  it('rechnet Mired und Kelvin gegeneinander um', () => {
    assert.equal(miredToKelvin(370), 2703);
    assert.equal(kelvinToMired(2700), 370);
    assert.equal(miredToKelvin(kelvinToMired(4000)), 4000);
  });

  it('hält Mirek im von Hue akzeptierten Bereich', () => {
    assert.equal(clampMirek(10), 153);
    assert.equal(clampMirek(9999), 500);
    assert.equal(clampMirek(250), 250);
  });
});
