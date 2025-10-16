#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { OrderSide, OrderType, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';

const client = new EnclaveClient(
  'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
  'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
  Environment.PROD
);

async function addRealTPSL() {
  try {
    console.log('🔧 Adding REAL TP/SL to AVAX position...\n');

    // Get current AVAX position
    const positions = await client.getPositions();
    const avaxPos = positions.find(p => p.symbol === 'AVAX-USD.P');

    if (!avaxPos) {
      console.log('❌ No AVAX position found');
      return;
    }

    const entryPrice = parseFloat(avaxPos.entryPrice?.toString() || '0');
    const quantity = avaxPos.quantity;

    console.log(`📊 AVAX Position: ${quantity?.toString()} @ $${entryPrice.toFixed(3)}`);

    // Calculate TP/SL levels with proper rounding to 0.001 increment
    const takeProfitRaw = entryPrice * 1.015; // 1.5% above
    const takeProfitRounded = Math.round(takeProfitRaw * 1000) / 1000; // Round to 0.001
    const takeProfitPrice = new Decimal(takeProfitRounded);

    const stopLossPrice = new Decimal(entryPrice * 0.985);   // 1.5% below

    console.log(`🎯 Target Levels:`);
    console.log(`   Take Profit: $${takeProfitPrice.toFixed(3)} (rounded to 0.001 increment)`);
    console.log(`   Stop Loss: $${stopLossPrice.toFixed(3)} (bot-monitored)`);

    // Place LIMIT order for take profit
    try {
      console.log('\n📈 Placing Take Profit LIMIT order...');
      const tpOrder = await client.addOrder(
        'AVAX-USD.P',
        OrderSide.SELL,  // Sell to close long position
        quantity,
        OrderType.LIMIT,
        takeProfitPrice
      );

      console.log(`✅ Take Profit order placed: ${tpOrder.id} @ $${takeProfitPrice.toFixed(3)}`);
    } catch (error: any) {
      console.error('❌ Failed to place TP order:', error.message);
    }

    // Show current market status
    const marketData = await client.getMarketData('AVAX-USD.P');
    const currentPrice = parseFloat(marketData.last.toString());

    console.log('\n📊 Current Status:');
    console.log(`   Current Price: $${currentPrice.toFixed(3)}`);
    console.log(`   Distance to TP: ${((takeProfitPrice.toNumber() - currentPrice) / currentPrice * 100).toFixed(2)}%`);
    console.log(`   Distance to SL: ${((currentPrice - stopLossPrice.toNumber()) / currentPrice * 100).toFixed(2)}% buffer`);

    console.log('\n✅ NOW you should see the TP order in Enclave GUI!');
    console.log('• Take Profit: LIMIT sell order visible');
    console.log('• Stop Loss: Needs to be monitored by bot (manual market order when triggered)');

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

addRealTPSL().catch(console.error);