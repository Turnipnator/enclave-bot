#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { OrderSide, OrderType, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';
import pino from 'pino';

const logger = pino({ name: 'ManualTPSL' });

async function manualTPSL() {
  const client = new EnclaveClient(
    'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
    'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
    Environment.PROD,
    'bot'
  );

  try {
    logger.info('📊 Current positions:');
    const positions = await client.getPositions();
    for (const position of positions) {
      logger.info(`  ${position.symbol}: ${position.side} ${position.quantity} @ ${position.entryPrice}`);
    }

    // Manually place TP/SL for SOL position (0.1 SOL @ 238.21)
    logger.info('\n🎯 Placing orders for SOL-USD.P position...');

    // Stop loss at 2.5% below entry: 238.21 * 0.975 = 232.25
    const solStopLoss = new Decimal('232.25');
    const solTakeProfit = new Decimal('247.74'); // 4% above entry: 238.21 * 1.04

    // Get the exact position quantity
    const solPosition = positions.find(p => p.symbol === 'SOL-USD.P');
    if (!solPosition) {
      logger.error('SOL position not found');
      return;
    }

    logger.info(`Using exact position quantity: ${solPosition.quantity}`);

    // Place take profit (try LIMIT first since it had clearer error)
    try {
      logger.info(`Placing SOL take profit: ${solPosition.quantity} SOL at $247.74...`);
      const tpOrder = await client.addOrder(
        'SOL-USD.P',
        OrderSide.SELL,
        solPosition.quantity,
        OrderType.LIMIT,
        solTakeProfit
      );
      logger.info(`✅ SOL take profit placed: ${JSON.stringify(tpOrder)}`);
    } catch (error: any) {
      logger.error({ error: error.message, response: error.response?.data }, '❌ SOL take profit failed');
    }

    // Place stop loss
    try {
      logger.info(`Placing SOL stop loss: ${solPosition.quantity} SOL at $232.25...`);
      const stopOrder = await client.addOrder(
        'SOL-USD.P',
        OrderSide.SELL,
        solPosition.quantity,
        OrderType.STOP,
        solStopLoss
      );
      logger.info(`✅ SOL stop loss placed: ${JSON.stringify(stopOrder)}`);
    } catch (error: any) {
      logger.error({ error: error.message, response: error.response?.data }, '❌ SOL stop loss failed');
    }

  } catch (error: any) {
    logger.error({
      error: error.message,
      stack: error.stack,
      response: error.response?.data
    }, 'Script failed');
  }
}

// Run the script
manualTPSL().catch(console.error);