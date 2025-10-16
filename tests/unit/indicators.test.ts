import Decimal from 'decimal.js';
import { TechnicalIndicators, PriceData } from '../../src/core/indicators/TechnicalIndicators';

describe('TechnicalIndicators', () => {
  const generatePriceData = (count: number, basePrice = 100): PriceData[] => {
    const data: PriceData[] = [];
    for (let i = 0; i < count; i++) {
      const price = basePrice + Math.sin(i / 5) * 10;
      data.push({
        high: new Decimal(price + 2),
        low: new Decimal(price - 2),
        close: new Decimal(price),
        volume: new Decimal(1000 + Math.random() * 500),
        timestamp: new Date(Date.now() - (count - i) * 60000),
      });
    }
    return data;
  };

  describe('calculateResistance', () => {
    it('should calculate the highest price in the lookback period', () => {
      const prices = generatePriceData(20);
      const resistance = TechnicalIndicators.calculateResistance(prices, 10);

      const lastTenHighs = prices.slice(-10).map(p => p.high);
      const expectedResistance = Decimal.max(...lastTenHighs);

      expect(resistance.equals(expectedResistance)).toBe(true);
    });

    it('should throw error with insufficient data', () => {
      const prices = generatePriceData(5);
      expect(() => {
        TechnicalIndicators.calculateResistance(prices, 10);
      }).toThrow('Insufficient data');
    });
  });

  describe('calculateSupport', () => {
    it('should calculate the lowest price in the lookback period', () => {
      const prices = generatePriceData(20);
      const support = TechnicalIndicators.calculateSupport(prices, 10);

      const lastTenLows = prices.slice(-10).map(p => p.low);
      const expectedSupport = Decimal.min(...lastTenLows);

      expect(support.equals(expectedSupport)).toBe(true);
    });
  });

  describe('calculateAverageVolume', () => {
    it('should calculate the average volume correctly', () => {
      const prices = generatePriceData(20);
      const avgVolume = TechnicalIndicators.calculateAverageVolume(prices, 10);

      const lastTenVolumes = prices.slice(-10).map(p => p.volume);
      const sum = lastTenVolumes.reduce((acc, v) => acc.plus(v), new Decimal(0));
      const expectedAvg = sum.dividedBy(10);

      expect(avgVolume.equals(expectedAvg)).toBe(true);
    });
  });

  describe('isVolumeSpike', () => {
    it('should detect volume spike correctly', () => {
      const currentVolume = new Decimal(3000);
      const averageVolume = new Decimal(1000);

      expect(TechnicalIndicators.isVolumeSpike(currentVolume, averageVolume, 2)).toBe(true);
      expect(TechnicalIndicators.isVolumeSpike(currentVolume, averageVolume, 3.5)).toBe(false);
    });
  });

  describe('calculateRSI', () => {
    it('should calculate RSI correctly', () => {
      const prices = generatePriceData(30);
      const rsi = TechnicalIndicators.calculateRSI(prices, 14);

      // RSI should be between 0 and 100
      expect(rsi.greaterThanOrEqualTo(0)).toBe(true);
      expect(rsi.lessThanOrEqualTo(100)).toBe(true);
    });

    it('should return 100 when all changes are positive', () => {
      const prices: PriceData[] = [];
      for (let i = 0; i < 15; i++) {
        prices.push({
          high: new Decimal(100 + i),
          low: new Decimal(98 + i),
          close: new Decimal(99 + i),
          volume: new Decimal(1000),
          timestamp: new Date(),
        });
      }

      const rsi = TechnicalIndicators.calculateRSI(prices, 14);
      expect(rsi.equals(100)).toBe(true);
    });
  });

  describe('calculateSMA', () => {
    it('should calculate simple moving average correctly', () => {
      const prices = [
        new Decimal(100),
        new Decimal(102),
        new Decimal(104),
        new Decimal(103),
        new Decimal(105),
      ];

      const sma = TechnicalIndicators.calculateSMA(prices, 5);
      const expectedSma = new Decimal(102.8);

      expect(sma.equals(expectedSma)).toBe(true);
    });
  });

  describe('detectBreakout', () => {
    it('should detect bullish breakout', () => {
      const currentPrice = new Decimal(105);
      const resistance = new Decimal(100);
      const support = new Decimal(90);

      const breakout = TechnicalIndicators.detectBreakout(currentPrice, resistance, support);
      expect(breakout).toBe('BULLISH');
    });

    it('should detect bearish breakout', () => {
      const currentPrice = new Decimal(85);
      const resistance = new Decimal(100);
      const support = new Decimal(90);

      const breakout = TechnicalIndicators.detectBreakout(currentPrice, resistance, support);
      expect(breakout).toBe('BEARISH');
    });

    it('should return null when no breakout', () => {
      const currentPrice = new Decimal(95);
      const resistance = new Decimal(100);
      const support = new Decimal(90);

      const breakout = TechnicalIndicators.detectBreakout(currentPrice, resistance, support);
      expect(breakout).toBeNull();
    });
  });

  describe('calculateBollingerBands', () => {
    it('should calculate Bollinger Bands correctly', () => {
      const prices = generatePriceData(20).map(p => p.close);
      const bands = TechnicalIndicators.calculateBollingerBands(prices, 20, 2);

      expect(bands.upper.greaterThan(bands.middle)).toBe(true);
      expect(bands.middle.greaterThan(bands.lower)).toBe(true);
    });
  });
});