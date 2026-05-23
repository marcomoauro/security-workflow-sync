import { describe, it, expect } from 'vitest';
import { pickEnumColor, ENUM_OPTION_COLORS } from '../../../src/providers/asana/schema.js';

describe('pickEnumColor', () => {
  it('is deterministic — same name always maps to the same color', () => {
    const a = pickEnumColor('Werkzeug');
    const b = pickEnumColor('Werkzeug');
    expect(a).toBe(b);
  });

  it('is case-insensitive (Werkzeug and werkzeug get the same color)', () => {
    expect(pickEnumColor('Werkzeug')).toBe(pickEnumColor('werkzeug'));
    expect(pickEnumColor('WERKZEUG')).toBe(pickEnumColor('werkzeug'));
  });

  it('only returns colors from the documented palette', () => {
    const samples = ['lodash', 'axios', 'react', 'django', 'flask', 'rails', 'pandas', 'numpy', 'spring', 'expressjs'];
    for (const name of samples) {
      expect(ENUM_OPTION_COLORS).toContain(pickEnumColor(name));
    }
  });

  it('produces different colors for different names (no trivial collapse)', () => {
    const samples = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'];
    const colors = new Set(samples.map(pickEnumColor));
    // Not a strict requirement, but with 15 names and 14 colors we expect > 5 distinct
    expect(colors.size).toBeGreaterThan(5);
  });
});
