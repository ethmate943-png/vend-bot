const { parseHaggle, floorAboveMin } = require('../../../src/whatsapp/listener/utils');

describe('listener/utils', () => {
  describe('parseHaggle', () => {
    it('returns round 0 counter 0 for empty or non-haggle ref', () => {
      expect(parseHaggle()).toEqual({ round: 0, counter: 0 });
      expect(parseHaggle('')).toEqual({ round: 0, counter: 0 });
      expect(parseHaggle('pay:123')).toEqual({ round: 0, counter: 0 });
    });

    it('parses haggle:round:counter', () => {
      expect(parseHaggle('haggle:1:25000')).toEqual({ round: 1, counter: 25000 });
      expect(parseHaggle('haggle:2:22000')).toEqual({ round: 2, counter: 22000 });
    });

    it('handles missing/invalid numbers as 0', () => {
      expect(parseHaggle('haggle::')).toEqual({ round: 0, counter: 0 });
      expect(parseHaggle('haggle:1:')).toEqual({ round: 1, counter: 0 });
    });
  });

  describe('floorAboveMin', () => {
    it('returns price when above min', () => {
      expect(floorAboveMin(30000, 20000)).toBe(30000);
      expect(floorAboveMin(25000, 20000)).toBe(25000);
    });

    it('returns at least min + buffer when price is below min', () => {
      const min = 10000;
      const result = floorAboveMin(5000, min);
      expect(result).toBeGreaterThanOrEqual(min);
      expect(result).toBeLessThanOrEqual(min + 1000);
    });

    it('uses 5% buffer with minimum 500', () => {
      const min = 10000;
      const buffer = Math.max(Math.round(min * 0.05), 500);
      expect(floorAboveMin(min - 1, min)).toBe(min + buffer);
    });
  });
});
