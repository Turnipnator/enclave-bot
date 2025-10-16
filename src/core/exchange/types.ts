import Decimal from 'decimal.js';

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP = 'STOP',
  STOP_LIMIT = 'STOP_LIMIT',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  FILLED = 'FILLED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
}

export enum Environment {
  PROD = 'PROD',
  TESTNET = 'TESTNET',
}

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: Decimal;
  quantity: Decimal;
  status: OrderStatus;
  filledQuantity?: Decimal;
  averagePrice?: Decimal;
  timestamp: Date;
  clientOrderId?: string;
}

export interface Position {
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  margin: Decimal;
  liquidationPrice?: Decimal;
  timestamp: Date;
}

export interface Balance {
  asset: string;
  available: Decimal;
  locked: Decimal;
  total: Decimal;
}

export interface MarketData {
  symbol: string;
  bid: Decimal;
  ask: Decimal;
  last: Decimal;
  volume24h: Decimal;
  high24h: Decimal;
  low24h: Decimal;
  timestamp: Date;
}

export interface Trade {
  id: string;
  symbol: string;
  side: OrderSide;
  price: Decimal;
  quantity: Decimal;
  timestamp: Date;
  isMaker: boolean;
}

export interface OrderBook {
  symbol: string;
  bids: Array<{ price: Decimal; quantity: Decimal }>;
  asks: Array<{ price: Decimal; quantity: Decimal }>;
  timestamp: Date;
}

export interface FundingRate {
  symbol: string;
  rate: Decimal;
  nextFundingTime: Date;
}

export interface WebSocketMessage {
  type: string;
  channel?: string;
  data?: unknown;
  timestamp?: number;
}