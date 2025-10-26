import { config as dotenvConfig } from 'dotenv';
import Decimal from 'decimal.js';
import { Environment } from '../core/exchange/types';

dotenvConfig();

export interface Config {
  // API Configuration
  apiKey: string;
  apiSecret: string;
  environment: Environment;
  subaccountName?: string;

  // Trading Mode
  tradingMode: 'paper' | 'live';

  // Markets
  tradingPairs: string[];

  // Risk Management
  maxDailyLoss: Decimal;
  maxPositions: number;
  positionSize: Decimal;
  maxLeverage: number;
  maxDrawdown: Decimal;

  // Volume Farming
  enableVolumeFarming: boolean;
  minTradeInterval: number;
  targetDailyTrades: number;
  spreadTolerance: Decimal;

  // Breakout Strategy
  lookbackPeriod: number;
  volumeMultiplier: number;
  trailingStopPercent: number;
  useScalping: boolean;
  breakoutBuffer: number;
  takeProfitPercent?: number;

  // Logging
  logLevel: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && !defaultValue) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue || '';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvDecimal(key: string, defaultValue: string): Decimal {
  const value = process.env[key] || defaultValue;
  return new Decimal(value);
}

function validateConfig(config: Config): void {
  // Validate numeric values are positive
  if (config.maxDailyLoss.lessThanOrEqualTo(0)) {
    throw new Error('MAX_DAILY_LOSS must be positive');
  }
  if (config.maxPositions <= 0) {
    throw new Error('MAX_POSITIONS must be positive');
  }
  if (config.positionSize.lessThanOrEqualTo(0)) {
    throw new Error('POSITION_SIZE must be positive');
  }
  if (config.maxLeverage <= 0) {
    throw new Error('MAX_LEVERAGE must be positive');
  }
  if (config.maxDrawdown.lessThanOrEqualTo(0) || config.maxDrawdown.greaterThan(100)) {
    throw new Error('MAX_DRAWDOWN must be between 0 and 100');
  }

  // Validate strategy parameters
  if (config.lookbackPeriod < 2) {
    throw new Error('LOOKBACK_PERIOD must be at least 2');
  }
  if (config.volumeMultiplier <= 0) {
    throw new Error('VOLUME_MULTIPLIER must be positive');
  }
  if (config.trailingStopPercent <= 0 || config.trailingStopPercent >= 100) {
    throw new Error('TRAILING_STOP_PERCENT must be between 0 and 100');
  }
  if (config.takeProfitPercent && (config.takeProfitPercent <= 0 || config.takeProfitPercent >= 1000)) {
    throw new Error('TAKE_PROFIT_PERCENT must be between 0 and 1000');
  }

  // Validate trading mode
  if (config.tradingMode !== 'paper' && config.tradingMode !== 'live') {
    throw new Error('TRADING_MODE must be "paper" or "live"');
  }

  // Validate trading pairs
  if (config.tradingPairs.length === 0) {
    throw new Error('TRADING_PAIRS must contain at least one pair');
  }
}

export function loadConfig(): Config {
  const config = {
    // API Configuration
    apiKey: getEnvVar('ENCLAVE_API_KEY'),
    apiSecret: getEnvVar('ENCLAVE_API_SECRET'),
    environment: (getEnvVar('ENCLAVE_ENV', 'PROD') as Environment),
    subaccountName: process.env.SUBACCOUNT_NAME,

    // Trading Mode
    tradingMode: getEnvVar('TRADING_MODE', 'paper') as 'paper' | 'live',

    // Markets
    tradingPairs: getEnvVar('TRADING_PAIRS', 'ETH-USD.P,SOL-USD.P,AVAX-USD.P').split(',').map(s => s.trim()),

    // Risk Management
    maxDailyLoss: getEnvDecimal('MAX_DAILY_LOSS', '25'),
    maxPositions: getEnvNumber('MAX_POSITIONS', 3),
    positionSize: getEnvDecimal('POSITION_SIZE', '0.001'),
    maxLeverage: getEnvNumber('MAX_LEVERAGE', 3),
    maxDrawdown: getEnvDecimal('MAX_DRAWDOWN', '10'),

    // Volume Farming
    enableVolumeFarming: getEnvBoolean('ENABLE_VOLUME_FARMING', false),
    minTradeInterval: getEnvNumber('MIN_TRADE_INTERVAL', 60),
    targetDailyTrades: getEnvNumber('TARGET_DAILY_TRADES', 100),
    spreadTolerance: getEnvDecimal('SPREAD_TOLERANCE', '0.001'),

    // Breakout Strategy
    lookbackPeriod: getEnvNumber('LOOKBACK_PERIOD', 10),
    volumeMultiplier: getEnvNumber('VOLUME_MULTIPLIER', 1.5),
    trailingStopPercent: getEnvNumber('TRAILING_STOP_PERCENT', 1.5),
    useScalping: getEnvBoolean('USE_SCALPING', true),
    breakoutBuffer: getEnvNumber('BREAKOUT_BUFFER', 0.001),
    takeProfitPercent: process.env.TAKE_PROFIT_PERCENT ? getEnvNumber('TAKE_PROFIT_PERCENT', 3) : undefined,

    // Logging
    logLevel: getEnvVar('LOG_LEVEL', 'info'),
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

export const config = loadConfig();