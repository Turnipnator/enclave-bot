import Decimal from 'decimal.js';

export interface PriceData {
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  timestamp: Date;
}

export class TechnicalIndicators {
  public static calculateResistance(prices: PriceData[], lookbackPeriod: number): Decimal {
    if (prices.length < lookbackPeriod) {
      throw new Error(`Insufficient data: need ${lookbackPeriod} periods, got ${prices.length}`);
    }

    const recentPrices = prices.slice(-lookbackPeriod);
    const highs = recentPrices.map((p) => p.high);
    return Decimal.max(...highs);
  }

  public static calculateSupport(prices: PriceData[], lookbackPeriod: number): Decimal {
    if (prices.length < lookbackPeriod) {
      throw new Error(`Insufficient data: need ${lookbackPeriod} periods, got ${prices.length}`);
    }

    const recentPrices = prices.slice(-lookbackPeriod);
    const lows = recentPrices.map((p) => p.low);
    return Decimal.min(...lows);
  }

  public static calculateAverageVolume(prices: PriceData[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data: need ${periods} periods, got ${prices.length}`);
    }

    const recentPrices = prices.slice(-periods);
    const totalVolume = recentPrices.reduce(
      (sum, p) => sum.plus(p.volume),
      new Decimal(0)
    );
    return totalVolume.dividedBy(periods);
  }

  public static isVolumeSpike(
    currentVolume: Decimal,
    averageVolume: Decimal,
    multiplier: number
  ): boolean {
    return currentVolume.greaterThan(averageVolume.times(multiplier));
  }

  public static calculateATR(prices: PriceData[], periods: number): Decimal {
    if (prices.length < periods + 1) {
      throw new Error(`Insufficient data for ATR calculation`);
    }

    const trueRanges: Decimal[] = [];
    for (let i = 1; i < prices.length; i++) {
      const high = prices[i].high;
      const low = prices[i].low;
      const prevClose = prices[i - 1].close;

      const tr1 = high.minus(low);
      const tr2 = high.minus(prevClose).abs();
      const tr3 = low.minus(prevClose).abs();

      trueRanges.push(Decimal.max(tr1, tr2, tr3));
    }

    const recentTRs = trueRanges.slice(-periods);
    const sum = recentTRs.reduce((acc, tr) => acc.plus(tr), new Decimal(0));
    return sum.dividedBy(periods);
  }

  public static calculateRSI(prices: PriceData[], periods = 14): Decimal {
    if (prices.length < periods + 1) {
      throw new Error(`Insufficient data for RSI calculation`);
    }

    const changes: Decimal[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i].close.minus(prices[i - 1].close));
    }

    const recentChanges = changes.slice(-periods);
    const gains = recentChanges.filter((c) => c.greaterThan(0));
    const losses = recentChanges.filter((c) => c.lessThan(0)).map((c) => c.abs());

    // RSI uses smoothed averages over the full period
    // Sum all gains and losses, then divide by period (treating no-change as 0)
    const totalGain = gains.reduce((sum, g) => sum.plus(g), new Decimal(0));
    const totalLoss = losses.reduce((sum, l) => sum.plus(l), new Decimal(0));

    const avgGain = totalGain.dividedBy(periods);
    const avgLoss = totalLoss.dividedBy(periods);

    if (avgLoss.isZero()) {
      return new Decimal(100);
    }

    const rs = avgGain.dividedBy(avgLoss);
    return new Decimal(100).minus(new Decimal(100).dividedBy(rs.plus(1)));
  }

  public static calculateSMA(prices: Decimal[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for SMA calculation`);
    }

    const recentPrices = prices.slice(-periods);
    const sum = recentPrices.reduce((acc, p) => acc.plus(p), new Decimal(0));
    return sum.dividedBy(periods);
  }

  public static calculateEMA(prices: Decimal[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for EMA calculation`);
    }

    const multiplier = new Decimal(2).dividedBy(periods + 1);
    let ema = this.calculateSMA(prices.slice(0, periods), periods);

    for (let i = periods; i < prices.length; i++) {
      ema = prices[i].times(multiplier).plus(ema.times(new Decimal(1).minus(multiplier)));
    }

    return ema;
  }

  public static calculateBollingerBands(
    prices: Decimal[],
    periods = 20,
    stdDev = 2
  ): { upper: Decimal; middle: Decimal; lower: Decimal } {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for Bollinger Bands calculation`);
    }

    const sma = this.calculateSMA(prices, periods);
    const recentPrices = prices.slice(-periods);

    const squaredDiffs = recentPrices.map((p) => p.minus(sma).pow(2));
    const variance = squaredDiffs.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(periods);
    const standardDeviation = variance.sqrt();

    return {
      upper: sma.plus(standardDeviation.times(stdDev)),
      middle: sma,
      lower: sma.minus(standardDeviation.times(stdDev)),
    };
  }

  public static detectBreakout(
    currentPrice: Decimal,
    resistance: Decimal,
    support: Decimal,
    buffer = 0.001 // 0.1% buffer to avoid noise
  ): 'BULLISH' | 'BEARISH' | null {
    const resistanceWithBuffer = resistance.times(1 + buffer);
    const supportWithBuffer = support.times(1 - buffer);

    if (currentPrice.greaterThan(resistanceWithBuffer)) {
      return 'BULLISH';
    }

    if (currentPrice.lessThan(supportWithBuffer)) {
      return 'BEARISH';
    }

    return null;
  }

  /**
   * Detect market trend using moving average crossover
   * Returns UPTREND if 20-MA > 50-MA, DOWNTREND if 20-MA < 50-MA, SIDEWAYS otherwise
   */
  public static detectTrend(
    prices: PriceData[],
    shortPeriod = 20,
    longPeriod = 50
  ): 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' {
    if (prices.length < longPeriod) {
      return 'SIDEWAYS'; // Not enough data, assume sideways
    }

    const closePrices = prices.map(p => p.close);
    const ma20 = this.calculateSMA(closePrices.slice(-shortPeriod), shortPeriod);
    const ma50 = this.calculateSMA(closePrices.slice(-longPeriod), longPeriod);

    // Add hysteresis to avoid flip-flopping (0.2% threshold)
    const threshold = ma50.times(0.002);

    if (ma20.greaterThan(ma50.plus(threshold))) {
      return 'UPTREND';
    } else if (ma20.lessThan(ma50.minus(threshold))) {
      return 'DOWNTREND';
    } else {
      return 'SIDEWAYS';
    }
  }

  /**
   * Detect price structure (higher highs/lower lows)
   * Confirms trend direction by analyzing swing points
   */
  public static detectPriceStructure(
    prices: PriceData[],
    lookback = 10
  ): 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'CHOPPY' {
    if (prices.length < lookback * 2) {
      return 'CHOPPY';
    }

    const recentPrices = prices.slice(-lookback * 2);
    const firstHalf = recentPrices.slice(0, lookback);
    const secondHalf = recentPrices.slice(lookback);

    const firstHigh = Decimal.max(...firstHalf.map(p => p.high));
    const firstLow = Decimal.min(...firstHalf.map(p => p.low));
    const secondHigh = Decimal.max(...secondHalf.map(p => p.high));
    const secondLow = Decimal.min(...secondHalf.map(p => p.low));

    // Higher highs AND higher lows = uptrend structure
    if (secondHigh.greaterThan(firstHigh) && secondLow.greaterThan(firstLow)) {
      return 'HIGHER_HIGHS';
    }

    // Lower highs AND lower lows = downtrend structure
    if (secondHigh.lessThan(firstHigh) && secondLow.lessThan(firstLow)) {
      return 'LOWER_LOWS';
    }

    return 'CHOPPY';
  }

  /**
   * Combined trend confirmation
   * Returns true only if both MA trend AND price structure agree
   */
  public static isTrendConfirmed(
    prices: PriceData[],
    expectedTrend: 'UPTREND' | 'DOWNTREND'
  ): boolean {
    const maTrend = this.detectTrend(prices);
    const structure = this.detectPriceStructure(prices);

    if (expectedTrend === 'UPTREND') {
      return maTrend === 'UPTREND' && structure === 'HIGHER_HIGHS';
    } else {
      return maTrend === 'DOWNTREND' && structure === 'LOWER_LOWS';
    }
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   * Returns MACD line, signal line, and histogram
   */
  public static calculateMACD(
    prices: Decimal[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9
  ): { macd: Decimal; signal: Decimal; histogram: Decimal } {
    if (prices.length < slowPeriod + signalPeriod) {
      throw new Error(`Insufficient data for MACD calculation`);
    }

    const fastEMA = this.calculateEMA(prices, fastPeriod);
    const slowEMA = this.calculateEMA(prices, slowPeriod);
    const macdLine = fastEMA.minus(slowEMA);

    // Calculate signal line (EMA of MACD values)
    // We need to calculate MACD for each point to get the signal line
    const macdValues: Decimal[] = [];
    for (let i = slowPeriod; i <= prices.length; i++) {
      const subPrices = prices.slice(0, i);
      const fast = this.calculateEMA(subPrices, fastPeriod);
      const slow = this.calculateEMA(subPrices, slowPeriod);
      macdValues.push(fast.minus(slow));
    }

    const signalLine = macdValues.length >= signalPeriod
      ? this.calculateEMA(macdValues, signalPeriod)
      : macdLine;

    const histogram = macdLine.minus(signalLine);

    return {
      macd: macdLine,
      signal: signalLine,
      histogram,
    };
  }

  /**
   * Calculate Stochastic Oscillator
   * Returns %K and %D values
   */
  public static calculateStochastic(
    prices: PriceData[],
    kPeriod = 14,
    dPeriod = 3
  ): { k: Decimal; d: Decimal } {
    if (prices.length < kPeriod + dPeriod) {
      throw new Error(`Insufficient data for Stochastic calculation`);
    }

    // Calculate %K values for the last dPeriod + 1 candles to get %D
    const kValues: Decimal[] = [];
    for (let i = kPeriod - 1; i < prices.length; i++) {
      const periodPrices = prices.slice(i - kPeriod + 1, i + 1);
      const highest = Decimal.max(...periodPrices.map(p => p.high));
      const lowest = Decimal.min(...periodPrices.map(p => p.low));
      const currentClose = periodPrices[periodPrices.length - 1].close;

      const range = highest.minus(lowest);
      const k = range.isZero()
        ? new Decimal(50) // Default to 50 if no range
        : currentClose.minus(lowest).dividedBy(range).times(100);
      kValues.push(k);
    }

    // Current %K
    const currentK = kValues[kValues.length - 1];

    // %D is SMA of last dPeriod %K values
    const recentKs = kValues.slice(-dPeriod);
    const d = recentKs.reduce((sum, k) => sum.plus(k), new Decimal(0)).dividedBy(dPeriod);

    return { k: currentK, d };
  }

  /**
   * Detect EMA Stack trend (EMA20 > EMA50 > EMA200 for BULLISH)
   * This is the strong trend confirmation used by the winning strategy
   */
  public static detectEMAStack(
    prices: Decimal[]
  ): 'BULLISH' | 'BEARISH' | 'SIDEWAYS' {
    if (prices.length < 200) {
      return 'SIDEWAYS'; // Not enough data for full EMA stack
    }

    const ema20 = this.calculateEMA(prices, 20);
    const ema50 = this.calculateEMA(prices, 50);
    const ema200 = this.calculateEMA(prices, 200);

    // BULLISH: EMA20 > EMA50 > EMA200 (all stacked bullishly)
    if (ema20.greaterThan(ema50) && ema50.greaterThan(ema200)) {
      return 'BULLISH';
    }

    // BEARISH: EMA20 < EMA50 < EMA200 (all stacked bearishly)
    if (ema20.lessThan(ema50) && ema50.lessThan(ema200)) {
      return 'BEARISH';
    }

    // Mixed alignment = SIDEWAYS (choppy, ranging)
    return 'SIDEWAYS';
  }

  /**
   * Calculate composite momentum score (0.0 to 1.0)
   * Combines RSI, MACD, EMAs, Bollinger, and Stochastic
   * Score >= 0.60 = strong signal (entry zone)
   * Score >= 0.70 = very strong signal (excellent entry)
   */
  public static calculateMomentumScore(
    prices: PriceData[],
    direction: 'LONG' | 'SHORT'
  ): { score: Decimal; components: Record<string, number> } {
    if (prices.length < 200) {
      return { score: new Decimal(0), components: {} };
    }

    const closePrices = prices.map(p => p.close);
    const currentPrice = closePrices[closePrices.length - 1];
    let totalScore = new Decimal(0);
    const components: Record<string, number> = {};

    // 1. RSI Position (0-0.20)
    // For LONG: RSI 30-50 is ideal (not overbought, room to run)
    // For SHORT: RSI 50-70 is ideal (not oversold, room to fall)
    const rsi = this.calculateRSI(prices, 14);
    let rsiScore = 0;
    if (direction === 'LONG') {
      if (rsi.greaterThanOrEqualTo(30) && rsi.lessThanOrEqualTo(50)) {
        rsiScore = 0.20; // Ideal zone
      } else if (rsi.greaterThan(50) && rsi.lessThanOrEqualTo(60)) {
        rsiScore = 0.15; // OK zone
      } else if (rsi.greaterThan(60) && rsi.lessThanOrEqualTo(70)) {
        rsiScore = 0.08; // Getting overbought
      } else if (rsi.lessThan(30)) {
        rsiScore = 0.12; // Oversold, could bounce but risky
      }
      // RSI > 70 = 0 (overbought, don't buy)
    } else {
      if (rsi.greaterThanOrEqualTo(50) && rsi.lessThanOrEqualTo(70)) {
        rsiScore = 0.20; // Ideal zone for shorts
      } else if (rsi.greaterThanOrEqualTo(40) && rsi.lessThan(50)) {
        rsiScore = 0.15; // OK zone
      } else if (rsi.greaterThanOrEqualTo(30) && rsi.lessThan(40)) {
        rsiScore = 0.08; // Getting oversold
      } else if (rsi.greaterThan(70)) {
        rsiScore = 0.12; // Overbought, could dump but risky
      }
      // RSI < 30 = 0 (oversold, don't short)
    }
    totalScore = totalScore.plus(rsiScore);
    components.rsi = rsiScore;

    // 2. MACD Alignment (0-0.20)
    // For LONG: MACD > signal, histogram positive
    // For SHORT: MACD < signal, histogram negative
    const macd = this.calculateMACD(closePrices);
    let macdScore = 0;
    if (direction === 'LONG') {
      if (macd.macd.greaterThan(macd.signal) && macd.histogram.greaterThan(0)) {
        macdScore = 0.20; // Full bullish alignment
      } else if (macd.macd.greaterThan(macd.signal)) {
        macdScore = 0.12; // MACD above signal but histogram weak
      } else if (macd.histogram.greaterThan(0)) {
        macdScore = 0.08; // Histogram positive but MACD not above signal yet
      }
    } else {
      if (macd.macd.lessThan(macd.signal) && macd.histogram.lessThan(0)) {
        macdScore = 0.20; // Full bearish alignment
      } else if (macd.macd.lessThan(macd.signal)) {
        macdScore = 0.12; // MACD below signal but histogram weak
      } else if (macd.histogram.lessThan(0)) {
        macdScore = 0.08; // Histogram negative but MACD not below signal yet
      }
    }
    totalScore = totalScore.plus(macdScore);
    components.macd = macdScore;

    // 3. EMA Alignment (0-0.25) - Most important!
    // For LONG: Price > EMA20 > EMA50 > EMA200
    // For SHORT: Price < EMA20 < EMA50 < EMA200
    const ema20 = this.calculateEMA(closePrices, 20);
    const ema50 = this.calculateEMA(closePrices, 50);
    const ema200 = this.calculateEMA(closePrices, 200);
    let emaScore = 0;
    if (direction === 'LONG') {
      const priceAboveEma20 = currentPrice.greaterThan(ema20);
      const ema20AboveEma50 = ema20.greaterThan(ema50);
      const ema50AboveEma200 = ema50.greaterThan(ema200);

      if (priceAboveEma20 && ema20AboveEma50 && ema50AboveEma200) {
        emaScore = 0.25; // Perfect bullish stack
      } else if (priceAboveEma20 && ema20AboveEma50) {
        emaScore = 0.18; // Good but EMA50 not above 200
      } else if (priceAboveEma20) {
        emaScore = 0.10; // Price above short-term EMA only
      }
    } else {
      const priceBelowEma20 = currentPrice.lessThan(ema20);
      const ema20BelowEma50 = ema20.lessThan(ema50);
      const ema50BelowEma200 = ema50.lessThan(ema200);

      if (priceBelowEma20 && ema20BelowEma50 && ema50BelowEma200) {
        emaScore = 0.25; // Perfect bearish stack
      } else if (priceBelowEma20 && ema20BelowEma50) {
        emaScore = 0.18; // Good but EMA50 not below 200
      } else if (priceBelowEma20) {
        emaScore = 0.10; // Price below short-term EMA only
      }
    }
    totalScore = totalScore.plus(emaScore);
    components.ema = emaScore;

    // 4. Bollinger Band Position (0-0.15)
    // For LONG: Price near lower band = good entry
    // For SHORT: Price near upper band = good entry
    const bollinger = this.calculateBollingerBands(closePrices, 20, 2);
    const bbRange = bollinger.upper.minus(bollinger.lower);
    const pricePosition = currentPrice.minus(bollinger.lower).dividedBy(bbRange);
    let bbScore = 0;
    if (direction === 'LONG') {
      // Lower = better for longs (0.0-0.3 = best, 0.3-0.5 = OK)
      if (pricePosition.lessThanOrEqualTo(0.3)) {
        bbScore = 0.15; // Near lower band
      } else if (pricePosition.lessThanOrEqualTo(0.5)) {
        bbScore = 0.10; // Below middle
      } else if (pricePosition.lessThanOrEqualTo(0.7)) {
        bbScore = 0.05; // Above middle but not at top
      }
      // > 0.7 = 0 (too close to upper band)
    } else {
      // Higher = better for shorts (0.7-1.0 = best, 0.5-0.7 = OK)
      if (pricePosition.greaterThanOrEqualTo(0.7)) {
        bbScore = 0.15; // Near upper band
      } else if (pricePosition.greaterThanOrEqualTo(0.5)) {
        bbScore = 0.10; // Above middle
      } else if (pricePosition.greaterThanOrEqualTo(0.3)) {
        bbScore = 0.05; // Below middle but not at bottom
      }
      // < 0.3 = 0 (too close to lower band)
    }
    totalScore = totalScore.plus(bbScore);
    components.bollinger = bbScore;

    // 5. Stochastic Momentum (0-0.20)
    // For LONG: %K > %D and both rising from oversold
    // For SHORT: %K < %D and both falling from overbought
    const stochastic = this.calculateStochastic(prices);
    let stochScore = 0;
    if (direction === 'LONG') {
      if (stochastic.k.greaterThan(stochastic.d) && stochastic.k.lessThan(80)) {
        if (stochastic.k.lessThan(30)) {
          stochScore = 0.20; // Oversold and turning up - best!
        } else if (stochastic.k.lessThan(50)) {
          stochScore = 0.15; // Low zone and bullish
        } else {
          stochScore = 0.08; // Bullish but getting high
        }
      } else if (stochastic.k.lessThan(30)) {
        stochScore = 0.10; // Oversold but not confirmed
      }
    } else {
      if (stochastic.k.lessThan(stochastic.d) && stochastic.k.greaterThan(20)) {
        if (stochastic.k.greaterThan(70)) {
          stochScore = 0.20; // Overbought and turning down - best!
        } else if (stochastic.k.greaterThan(50)) {
          stochScore = 0.15; // High zone and bearish
        } else {
          stochScore = 0.08; // Bearish but getting low
        }
      } else if (stochastic.k.greaterThan(70)) {
        stochScore = 0.10; // Overbought but not confirmed
      }
    }
    totalScore = totalScore.plus(stochScore);
    components.stochastic = stochScore;

    return { score: totalScore, components };
  }
}