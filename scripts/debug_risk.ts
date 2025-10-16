import { config } from '../src/config/config';
import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { RiskManager } from '../src/core/risk/RiskManager';
import Decimal from 'decimal.js';

async function debugRisk() {
  try {
    console.log('Creating client and risk manager...');
    const client = new EnclaveClient(config.apiKey, config.apiSecret, config.environment, config.subaccountName);

    const riskManager = new RiskManager({
      maxDailyLoss: config.maxDailyLoss,
      maxPositions: config.maxPositions,
      positionSize: config.positionSize,
      maxLeverage: config.maxLeverage,
      maxDrawdown: config.maxDrawdown,
    });

    console.log('Fetching current balance and positions...');
    const balances = await client.getBalance();
    const positions = await client.getPositions();

    const balance = balances.find((b) => b.asset === 'USD') || {
      asset: 'USD',
      available: new Decimal(0),
      locked: new Decimal(0),
      total: new Decimal(0),
    };

    console.log('Current balance:', balance.total.toString());
    console.log('Current positions:', positions.length);

    const metrics = riskManager.getRiskMetrics(positions, balance);

    console.log('Risk Metrics:');
    console.log('- Daily PnL:', metrics.dailyPnl.toString());
    console.log('- Open Positions:', metrics.openPositions);
    console.log('- Total Exposure:', metrics.totalExposure.toString());
    console.log('- Current Drawdown:', metrics.currentDrawdown.toString(), '%');
    console.log('- Risk Score:', metrics.riskScore);

    console.log('\nMax drawdown config:', config.maxDrawdown.toString(), '%');
    console.log('Drawdown exceeds limit?', metrics.currentDrawdown.greaterThan(config.maxDrawdown));

    // Test if we can open a position
    const canOpen = riskManager.canOpenPosition(positions, balance, new Decimal(100));
    console.log('Can open position?', canOpen);

  } catch (error) {
    console.error('Error:', error);
  }
}

debugRisk();