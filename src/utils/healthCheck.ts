/**
 * Health Check Utility
 * Validates bot state and data quality to catch bugs early
 */

import Decimal from 'decimal.js';
import pino from 'pino';
import { PriceData } from '../core/indicators/TechnicalIndicators';

const logger = pino({ name: 'HealthCheck' });

export class HealthCheck {
  /**
   * Validate price history data quality
   * Catches corrupted data, stale timestamps, invalid prices
   */
  public static validatePriceHistory(
    symbol: string,
    history: PriceData[],
    minCandles: number = 10
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check minimum data
    if (history.length < minCandles) {
      errors.push(`Insufficient data: ${history.length} candles, need ${minCandles}`);
      return { valid: false, errors };
    }

    // Check for stale data (oldest candle > 12 hours old is suspicious)
    const oldestTimestamp = history[0].timestamp;
    const hoursSinceOldest = (Date.now() - oldestTimestamp.getTime()) / (1000 * 60 * 60);
    if (hoursSinceOldest > 12) {
      errors.push(`Data is stale: oldest candle is ${hoursSinceOldest.toFixed(1)} hours old`);
    }

    // Check newest candle is recent (< 70 minutes old - allows for hourly refresh cycle)
    const newestTimestamp = history[history.length - 1].timestamp;
    const minutesSinceNewest = (Date.now() - newestTimestamp.getTime()) / (1000 * 60);
    if (minutesSinceNewest > 70) {
      errors.push(`Latest candle is ${minutesSinceNewest.toFixed(1)} minutes old (should be < 70 min) - history refresh may have failed`);
    }

    // Check for zero/negative prices
    const invalidPrices = history.filter(
      (candle) =>
        candle.high.lessThanOrEqualTo(0) ||
        candle.low.lessThanOrEqualTo(0) ||
        candle.close.lessThanOrEqualTo(0)
    );
    if (invalidPrices.length > 0) {
      errors.push(`Found ${invalidPrices.length} candles with zero/negative prices`);
    }

    // Check for zero volume (suspicious, might indicate bad data)
    const zeroVolumeCandles = history.filter((candle) => candle.volume.isZero());
    if (zeroVolumeCandles.length > history.length * 0.5) {
      errors.push(`Too many zero-volume candles: ${zeroVolumeCandles.length}/${history.length}`);
    }

    // Check high >= low (basic sanity)
    const invalidRanges = history.filter((candle) => candle.high.lessThan(candle.low));
    if (invalidRanges.length > 0) {
      errors.push(`Found ${invalidRanges.length} candles where high < low (corrupted data)`);
    }

    // Check for massive price gaps (> 20% between consecutive candles = suspicious)
    for (let i = 1; i < history.length; i++) {
      const prevClose = history[i - 1].close;
      const currClose = history[i].close;
      const change = currClose.minus(prevClose).dividedBy(prevClose).abs().times(100);

      if (change.greaterThan(20)) {
        errors.push(`Suspicious price gap at candle ${i}: ${change.toFixed(1)}% change`);
        break; // Only report first gap
      }
    }

    if (errors.length > 0) {
      logger.warn({ symbol, errors }, `Price history validation failed for ${symbol}`);
      return { valid: false, errors };
    }

    logger.debug({ symbol, candles: history.length }, `Price history OK for ${symbol}`);
    return { valid: true, errors: [] };
  }

  /**
   * Check if support/resistance calculations are reasonable
   */
  public static validateSupportResistance(
    symbol: string,
    support: Decimal,
    resistance: Decimal,
    currentPrice: Decimal
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Support should be less than resistance
    if (support.greaterThanOrEqualTo(resistance)) {
      errors.push(`Support ($${support}) >= Resistance ($${resistance})`);
    }

    // Current price should be between support and resistance (usually)
    if (currentPrice.lessThan(support) || currentPrice.greaterThan(resistance)) {
      logger.debug(
        { symbol, support: support.toFixed(2), resistance: resistance.toFixed(2), currentPrice: currentPrice.toFixed(2) },
        `Price outside S/R range (this can be normal during breakouts)`
      );
    }

    // Support/resistance should not be zero
    if (support.isZero() || resistance.isZero()) {
      errors.push(`Zero support/resistance detected (data corruption?)`);
    }

    // Range should be reasonable (not > 50% of price)
    const range = resistance.minus(support);
    const rangePercent = range.dividedBy(currentPrice).times(100);
    if (rangePercent.greaterThan(50)) {
      errors.push(`S/R range too wide: ${rangePercent.toFixed(1)}% of price`);
    }

    if (errors.length > 0) {
      logger.error({ symbol, errors }, `Support/Resistance validation failed for ${symbol}`);
      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Log bot state for debugging
   */
  public static logBotState(
    symbol: string,
    historyLength: number,
    oldestCandle: Date,
    newestCandle: Date,
    support: Decimal,
    resistance: Decimal,
    currentPrice: Decimal
  ): void {
    const ageMinutes = (Date.now() - newestCandle.getTime()) / (1000 * 60);
    const historyHours = (newestCandle.getTime() - oldestCandle.getTime()) / (1000 * 60 * 60);

    logger.info({
      symbol,
      historyLength,
      historyAge: `${historyHours.toFixed(1)} hours`,
      newestCandleAge: `${ageMinutes.toFixed(1)} minutes ago`,
      support: support.toFixed(2),
      resistance: resistance.toFixed(2),
      currentPrice: currentPrice.toFixed(2),
      range: resistance.minus(support).dividedBy(currentPrice).times(100).toFixed(2) + '%'
    }, `Bot state for ${symbol}`);
  }
}
