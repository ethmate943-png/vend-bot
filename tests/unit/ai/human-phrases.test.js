const {
  selectionConfirm,
  outOfStock,
  listPrompt,
  listIntroFirst,
  listIntroAgain,
  alreadyHaveLink,
  paymentFailed,
  paymentIntro,
  noMatch,
  dailyCap,
  vendorUnavailable,
  listFooter,
  listIntroPurchase,
} = require('../../src/ai/human-phrases');

describe('human-phrases', () => {
  describe('selectionConfirm', () => {
    it('returns a string containing item name and formatted price', () => {
      const msg = selectionConfirm('Black Sneakers', 25000);
      expect(typeof msg).toBe('string');
      expect(msg).toContain('Black Sneakers');
      expect(msg).toMatch(/\d/);
      expect(msg.length).toBeGreaterThan(10);
    });

    it('formats price with locale', () => {
      const msg = selectionConfirm('Item', 1000);
      expect(msg).toContain('Item');
      expect(msg).toContain('1'); // 1,000 or 1000
    });
  });

  describe('outOfStock', () => {
    it('with itemName returns string containing the name', () => {
      const msg = outOfStock('Sneakers');
      expect(typeof msg).toBe('string');
      expect(msg).toContain('Sneakers');
    });

    it('without itemName returns a generic out-of-stock message', () => {
      const msg = outOfStock();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
      expect(msg.toLowerCase()).toMatch(/stock|else|something/);
    });
  });

  describe('listPrompt', () => {
    it('with max returns string containing the number', () => {
      const msg = listPrompt(5);
      expect(typeof msg).toBe('string');
      expect(msg).toContain('5');
    });

    it('without max returns a no-items message', () => {
      const msg = listPrompt(0);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('listIntroFirst', () => {
    it('returns a non-empty string', () => {
      const msg = listIntroFirst();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('listIntroAgain', () => {
    it('with max can include the number', () => {
      const msg = listIntroAgain(10);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('alreadyHaveLink', () => {
    it('returns string containing item or placeholder', () => {
      const msg = alreadyHaveLink('Sneakers');
      expect(msg).toContain('Sneakers');
      const fallback = alreadyHaveLink();
      expect(fallback).toMatch(/item|link|resend/i);
    });
  });

  describe('paymentFailed', () => {
    it('returns a short error message', () => {
      const msg = paymentFailed();
      expect(typeof msg).toBe('string');
      expect(msg.toLowerCase()).toMatch(/sorry|try again|wrong|link/);
    });
  });

  describe('paymentIntro', () => {
    it('returns a short string', () => {
      const msg = paymentIntro();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeLessThan(50);
    });
  });

  describe('noMatch', () => {
    it('returns a polite no-match message', () => {
      const msg = noMatch();
      expect(typeof msg).toBe('string');
      expect(msg.toLowerCase()).toMatch(/don't have|else|something/);
    });
  });

  describe('dailyCap', () => {
    it('returns a limit message', () => {
      const msg = dailyCap();
      expect(typeof msg).toBe('string');
      expect(msg.toLowerCase()).toMatch(/limit|tomorrow/);
    });
  });

  describe('vendorUnavailable', () => {
    it('returns an unavailable message', () => {
      const msg = vendorUnavailable();
      expect(typeof msg).toBe('string');
      expect(msg.toLowerCase()).toMatch(/unavailable|try again|later/);
    });
  });

  describe('listFooter', () => {
    it('returns a short footer', () => {
      const msg = listFooter();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('listIntroPurchase', () => {
    it('returns a short prompt', () => {
      const msg = listIntroPurchase();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(3);
    });
  });
});
