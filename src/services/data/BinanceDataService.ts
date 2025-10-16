import axios, { AxiosInstance } from 'axios';
import { Decimal } from 'decimal.js';
import pino from 'pino';

export interface Candle {
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export class BinanceDataService {
  private readonly client: AxiosInstance;
  private readonly logger = pino({ name: 'BinanceDataService' });

  // Map Enclave symbols to Binance symbols
  private readonly symbolMap: Record<string, string> = {
    'BTC-USD.P': 'BTCUSDT',
    'ETH-USD.P': 'ETHUSDT',
    'SOL-USD.P': 'SOLUSDT',
    'AVAX-USD.P': 'AVAXUSDT',
    'XRP-USD.P': 'XRPUSDT',
    'BNB-USD.P': 'BNBUSDT',
    'DOGE-USD.P': 'DOGEUSDT',
    'LINK-USD.P': 'LINKUSDT',
    'SUI-USD.P': 'SUIUSDT',
    'TON-USD.P': 'TONUSDT',
    'ADA-USD.P': 'ADAUSDT',
    // Note: Other pairs may not be available on Binance
    // These will fall back to Enclave's real-time data only
  };

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.binance.com',
      timeout: 10000,
    });
  }

  /**
   * Get historical klines/candles from Binance
   * @param symbol Enclave symbol (e.g., 'BTC-USD.P')
   * @param interval Time interval (1m, 5m, 15m, 1h, etc.)
   * @param limit Number of candles to fetch (max 1000)
   */
  public async getHistoricalCandles(
    symbol: string,
    interval: string = '5m',
    limit: number = 200
  ): Promise<Candle[]> {
    try {
      const binanceSymbol = this.symbolMap[symbol];
      if (!binanceSymbol) {
        throw new Error(`Symbol ${symbol} not supported for historical data`);
      }

      const response = await this.client.get('/api/v3/klines', {
        params: {
          symbol: binanceSymbol,
          interval,
          limit: Math.min(limit, 1000),
        },
      });

      return response.data.map((candle: any[]) => ({
        timestamp: candle[0],
        open: new Decimal(candle[1]),
        high: new Decimal(candle[2]),
        low: new Decimal(candle[3]),
        close: new Decimal(candle[4]),
        volume: new Decimal(candle[5]),
      }));
    } catch (error) {
      this.logger.error({ error, symbol }, 'Failed to fetch historical candles from Binance');
      throw error;
    }
  }

  /**
   * Get current price from Binance (useful for sanity checks)
   */
  public async getCurrentPrice(symbol: string): Promise<Decimal> {
    try {
      const binanceSymbol = this.symbolMap[symbol];
      if (!binanceSymbol) {
        throw new Error(`Symbol ${symbol} not supported`);
      }

      const response = await this.client.get('/api/v3/ticker/price', {
        params: { symbol: binanceSymbol },
      });

      return new Decimal(response.data.price);
    } catch (error) {
      this.logger.error({ error, symbol }, 'Failed to fetch current price from Binance');
      throw error;
    }
  }

  /**
   * Get market data (bid/ask) from Binance
   */
  public async getMarketData(symbol: string): Promise<{
    symbol: string;
    bid: Decimal;
    ask: Decimal;
    last: Decimal;
    volume24h: Decimal;
    high24h: Decimal;
    low24h: Decimal;
    timestamp: Date;
  }> {
    try {
      const binanceSymbol = this.symbolMap[symbol];
      if (!binanceSymbol) {
        throw new Error(`Symbol ${symbol} not supported for market data`);
      }

      // Get ticker data for bid/ask
      const tickerResponse = await this.client.get('/api/v3/ticker/bookTicker', {
        params: { symbol: binanceSymbol },
      });

      // Get 24hr stats for volume/high/low
      const statsResponse = await this.client.get('/api/v3/ticker/24hr', {
        params: { symbol: binanceSymbol },
      });

      return {
        symbol,
        bid: new Decimal(tickerResponse.data.bidPrice),
        ask: new Decimal(tickerResponse.data.askPrice),
        last: new Decimal(statsResponse.data.lastPrice),
        volume24h: new Decimal(statsResponse.data.volume),
        high24h: new Decimal(statsResponse.data.highPrice),
        low24h: new Decimal(statsResponse.data.lowPrice),
        timestamp: new Date()
      };
    } catch (error) {
      this.logger.error({ error, symbol }, 'Failed to fetch market data from Binance');
      throw error;
    }
  }

  /**
   * Convert Binance candles to price history format used by strategies
   */
  public static candlesToPriceHistory(candles: Candle[]): Array<{
    timestamp: Date;
    open: Decimal;
    high: Decimal;
    low: Decimal;
    close: Decimal;
    volume: Decimal;
  }> {
    return candles.map((candle) => ({
      timestamp: new Date(candle.timestamp),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }
}