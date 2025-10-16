#!/usr/bin/env tsx

import pino from 'pino';
import { config } from '../src/config/config';
import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { RiskManager } from '../src/core/risk/RiskManager';
import Decimal from 'decimal.js';

const logger = pino({
  name: 'ResetDrawdown',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

async function resetDrawdown(): Promise<void> {
  logger.info('Resetting drawdown calculation by updating peak balance...');

  const client = new EnclaveClient(config.apiKey, config.apiSecret, config.environment, config.subaccountName);

  try {
    await client.connect();

    // Get current balance
    const balances = await client.getBalance();
    const balance = balances.find((b) => b.asset === 'USD') || {
      asset: 'USD',
      available: new Decimal(0),
      locked: new Decimal(0),
      total: new Decimal(0),
    };

    logger.info(`Current USD balance: ${balance.total.toString()}`);

    // Create a new risk manager instance and reset peak balance
    const riskManager = new RiskManager({
      maxDailyLoss: config.maxDailyLoss,
      maxPositions: config.maxPositions,
      positionSize: config.positionSize,
      maxLeverage: config.maxLeverage,
      maxDrawdown: config.maxDrawdown,
    }, balance.total);

    // Reset peak balance to current balance
    riskManager.resetPeakBalance(balance.total);

    // Get positions to calculate current metrics
    const positions = await client.getPositions();
    const metrics = riskManager.getRiskMetrics(positions, balance);

    logger.info('Updated risk metrics:');
    logger.info(`  Current drawdown: ${metrics.currentDrawdown.toFixed(2)}%`);
    logger.info(`  Daily P&L: ${metrics.dailyPnl.toFixed(2)}`);
    logger.info(`  Risk score: ${metrics.riskScore}`);
    logger.info(`  Open positions: ${metrics.openPositions}`);

    if (metrics.currentDrawdown.lessThan(config.maxDrawdown)) {
      logger.info('✅ Drawdown is now within acceptable limits');
      logger.info('Bot should be able to trade again after restart');
    } else {
      logger.warn('⚠️  Drawdown is still above limit - check account balance');
    }

    client.disconnect();
    logger.info('Drawdown reset completed');
  } catch (error) {
    logger.error('Failed to reset drawdown:', error);
    process.exit(1);
  }
}

resetDrawdown()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });