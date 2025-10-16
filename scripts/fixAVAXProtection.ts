#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { OrderSide, OrderType, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';

const client = new EnclaveClient(
  'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
  'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
  Environment.PROD
);

async function fixAVAXProtection() {
  try {
    console.log('🔧 Adding Missing TP Protection for AVAX Position...\n');

    // Get AVAX position details
    const positions = await client.getPositions();
    const avaxPos = positions.find(p => p.symbol === 'AVAX-USD.P');

    if (!avaxPos) {
      console.log('❌ AVAX position not found');
      return;
    }

    const entryPrice = parseFloat(avaxPos.entryPrice?.toString() || '0');
    const quantity = avaxPos.quantity;

    console.log(`📊 AVAX Position: ${quantity?.toString()} @ $${entryPrice.toFixed(3)}`);

    // Calculate 4% take profit with proper rounding (AVAX uses 0.001 increment)
    const tpRaw = entryPrice * 1.04;
    const tpRounded = Math.round(tpRaw * 1000) / 1000; // Round to 0.001
    const takeProfitPrice = new Decimal(tpRounded);

    console.log(`🎯 Take Profit Level: $${takeProfitPrice.toFixed(3)} (+4%)`);

    // Check if TP order already exists for this exact position
    const orders = await client.getOpenOrders();
    const avaxLimitOrders = orders.filter(o =>
      o.symbol === 'AVAX-USD.P' &&
      o.type === 'LIMIT' &&
      o.side === 'SELL' &&
      o.status === 'OPEN' &&
      parseFloat(o.quantity?.toString() || '0') === parseFloat(quantity?.toString() || '0')
    );

    if (avaxLimitOrders.length > 0) {
      console.log('⚠️ AVAX already has matching TP orders:');
      avaxLimitOrders.forEach(o => {
        console.log(`  ${o.side} ${o.quantity?.toString()} @ $${o.price?.toString()}`);
      });
      console.log('Skipping TP order placement');
      return;
    }

    // Place LIMIT sell order for take profit
    console.log('\n📈 Placing Take Profit LIMIT order...');
    const tpOrder = await client.addOrder(
      'AVAX-USD.P',
      OrderSide.SELL,
      quantity,
      OrderType.LIMIT,
      takeProfitPrice
    );

    console.log(`✅ AVAX Take Profit order placed successfully!`);
    console.log(`   Order ID: ${tpOrder.id}`);
    console.log(`   Price: $${takeProfitPrice.toFixed(3)}`);
    console.log(`   Quantity: ${quantity?.toString()} AVAX`);

    // Get current price to show distance
    const marketData = await client.getMarketData('AVAX-USD.P');
    const currentPrice = parseFloat(marketData.last.toString());
    const distanceToTP = ((takeProfitPrice.toNumber() - currentPrice) / currentPrice * 100);

    console.log(`\n📊 Status:`);
    console.log(`   Current Price: $${currentPrice.toFixed(3)}`);
    console.log(`   Distance to TP: ${distanceToTP.toFixed(2)}%`);
    console.log(`   AVAX position is now protected!`);

  } catch (error: any) {
    console.error('❌ Failed to add AVAX protection:', error.message);
    if (error.response?.data) {
      console.error('API Error:', error.response.data);
    }
  }
}

fixAVAXProtection().catch(console.error);