import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import pino from 'pino';
import {
  Environment,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  Balance,
  MarketData,
  Trade,
  OrderBook,
  FundingRate,
  WebSocketMessage,
} from './types';

export class EnclaveClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly subaccountName?: string;
  private readonly httpClient: AxiosInstance;
  private ws?: WebSocket;
  private readonly logger: pino.Logger;
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 100; // Increased from 5 - keep trying to reconnect
  private pingInterval?: NodeJS.Timeout;
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();
  private marketDataCache: Map<string, MarketData> = new Map();
  private orderBookCache: Map<string, OrderBook> = new Map();

  constructor(apiKey: string, apiSecret: string, environment: Environment = Environment.PROD, subaccountName?: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.subaccountName = subaccountName;
    this.logger = pino({ name: 'EnclaveClient' });

    this.baseUrl =
      environment === Environment.PROD
        ? 'https://api.enclave.trade'
        : 'https://testnet-api.enclave.trade';

    this.wsUrl =
      environment === Environment.PROD
        ? 'wss://api.enclave.trade/ws'
        : 'wss://testnet-api.enclave.trade/ws';

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // Increased from 10s to 30s
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.httpClient.interceptors.request.use((config) => {
      const timestamp = Date.now();
      const path = this.buildFullPath(config.url || '', config.params);
      const body = config.data ? JSON.stringify(config.data) : '';
      const signature = this.generateSignature(
        config.method?.toUpperCase() || 'GET',
        path,
        body,
        timestamp
      );

      // Use Enclave's header format from Python client
      config.headers['ENCLAVE-KEY-ID'] = this.apiKey;
      config.headers['ENCLAVE-SIGN'] = signature;
      config.headers['ENCLAVE-TIMESTAMP'] = timestamp.toString();

      return config;
    });
  }

  private buildFullPath(path: string, params?: any): string {
    if (!params) return path;

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        query.append(key, String(value));
      }
    }

    const queryString = query.toString();
    return queryString ? `${path}?${queryString}` : path;
  }

  private generateSignature(
    method: string,
    path: string,
    body: string,
    timestamp: number
  ): string {
    const message = `${timestamp}${method}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  public async connect(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.logger.info('WebSocket connected');
        this.reconnectAttempts = 0;
        // Subscribe to public market data channels
        this.subscribeToPublicChannels();
        this.startPingInterval();
        resolve(true);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message: WebSocketMessage = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          this.logger.error({ error }, 'Failed to parse WebSocket message');
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error({ error }, 'WebSocket error');
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.warn('WebSocket disconnected');
        this.stopPingInterval();
        this.reconnect();
      });
    });
  }

  private subscribeToPublicChannels(): void {
    if (!this.ws) return;

    // Subscribe to all trading pairs from config instead of hardcoded list
    const { config } = require('../../config/config');
    const markets = config.tradingPairs;

    // Subscribe to top of book
    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'topOfBooksPerps',
        markets,
      })
    );

    // Subscribe to trades
    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'tradesPerps',
        markets,
      })
    );

    // Subscribe to depth books
    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'depthBooksPerps',
        markets,
      })
    );

    this.logger.info('Subscribed to public market data channels');
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((error) => {
        this.logger.error({ error }, 'Reconnection failed');
      });
    }, delay);
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  private handleMessage(message: any): void {
    if (message.type === 'pong') {
      return;
    }

    // Handle Enclave WebSocket messages
    if (message.type === 'update' && message.channel === 'topOfBooksPerps') {
      this.handleTopOfBookUpdate(message.data);
    } else if (message.type === 'update' && message.channel === 'depthBooksPerps') {
      this.handleDepthBookUpdate(message.data);
    } else if (message.type === 'update' && message.channel === 'tradesPerps') {
      this.handleTradesUpdate(message.data);
    } else if (message.type === 'subscribed') {
      this.logger.info(`Subscribed to ${message.channel}`);
    }

    // Legacy handler support
    if (message.channel) {
      const handler = this.messageHandlers.get(message.channel);
      if (handler) {
        handler(message.data);
      }
    }
  }

  private handleTopOfBookUpdate(data: any[]): void {
    for (const item of data) {
      const existing = this.marketDataCache.get(item.market) || {} as any;
      this.marketDataCache.set(item.market, {
        symbol: item.market,
        bid: item.bids?.[0] ? new Decimal(item.bids[0][0]) : new Decimal('0'),
        ask: item.asks?.[0] ? new Decimal(item.asks[0][0]) : new Decimal('0'),
        last: existing.last || (item.bids?.[0] ? new Decimal(item.bids[0][0]) : new Decimal('0')),
        volume24h: existing.volume24h || new Decimal('0'),
        high24h: existing.high24h || new Decimal('0'),
        low24h: existing.low24h || new Decimal('0'),
        timestamp: new Date(item.time),
      });
    }
  }

  private handleDepthBookUpdate(data: any[]): void {
    for (const item of data) {
      this.orderBookCache.set(item.market, {
        symbol: item.market,
        bids: (item.bids || []).map((b: any) => ({
          price: new Decimal(b[0]),
          quantity: new Decimal(b[1]),
        })),
        asks: (item.asks || []).map((a: any) => ({
          price: new Decimal(a[0]),
          quantity: new Decimal(a[1]),
        })),
        timestamp: new Date(item.time),
      });
    }
  }

  private handleTradesUpdate(data: any[]): void {
    // Update market data with latest trade price
    for (const trade of data) {
      const existing = this.marketDataCache.get(trade.market);
      if (existing) {
        existing.last = new Decimal(trade.price);
        existing.volume24h = existing.volume24h.plus(new Decimal(trade.size));
      }
    }
  }

  public subscribe(channel: string, handler: (data: unknown) => void): void {
    this.messageHandlers.set(channel, handler);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel,
        })
      );
    }
  }

  public unsubscribe(channel: string): void {
    this.messageHandlers.delete(channel);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'unsubscribe',
          channel,
        })
      );
    }
  }

  public async addOrder(
    symbol: string,
    side: OrderSide,
    quantity: Decimal,
    type: OrderType = OrderType.MARKET,
    price?: Decimal,
    clientOrderId?: string,
    stopLoss?: Decimal,
    takeProfit?: Decimal
  ): Promise<Order> {
    const data: Record<string, unknown> = {
      market: symbol,
      side: side.toLowerCase(),
      size: parseFloat(quantity.toString()),
      type: type.toLowerCase(),
    };

    // Only add timeInForce for limit orders, not market orders
    if (type === OrderType.LIMIT) {
      data.timeInForce = 'GTC';
    }

    if (price) {
      data.price = parseFloat(price.toString());
    }

    if (clientOrderId) {
      data.clientOrderId = clientOrderId;
    }

    // Add TP/SL parameters if provided
    if (stopLoss) {
      data.stopLoss = parseFloat(stopLoss.toString());
    }

    if (takeProfit) {
      data.takeProfit = parseFloat(takeProfit.toString());
    }

    // Use Bot subaccount for all trading
    if (this.subaccountName) {
      data.subaccount = this.subaccountName;
    }

    try {
      const response = await this.httpClient.post<Order>('/v1/perps/orders', data);
      return this.parseOrder(response.data);
    } catch (error: any) {
      this.logger.error({
        error: error.message,
        status: error.response?.status,
        responseData: error.response?.data,
        requestData: data
      }, 'Order placement failed');
      throw error;
    }
  }

  public async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.httpClient.delete(`/v1/perps/orders/${orderId}`);
      return true;
    } catch (error: any) {
      // 409 = order locked/not cancellable (expected for some orders)
      if (error.response && error.response.status === 409) {
        this.logger.debug({ orderId }, 'Order not cancellable (locked/protected)');
      } else {
        this.logger.error({ error }, 'Failed to cancel order');
      }
      return false;
    }
  }

  public async getOrder(orderId: string): Promise<Order> {
    const response = await this.httpClient.get<Order>(`/v1/perps/orders/${orderId}`);
    return this.parseOrder(response.data);
  }

  public async getOpenOrders(symbol?: string): Promise<Order[]> {
    // Enclave API doesn't support filtering by symbol, so we get all orders and filter client-side
    const response = await this.httpClient.get<any>('/v1/perps/orders');

    // Handle Enclave's success/result response format
    let orders: Order[] = [];
    if (response.data.success && Array.isArray(response.data.result)) {
      orders = response.data.result.map((order: any) => this.parseOrder(order));
    }

    // Filter by symbol if specified
    if (symbol) {
      orders = orders.filter(order => order.symbol === symbol);
    }

    // CRITICAL FIX: Only return truly open orders (not filled/cancelled ones)
    orders = orders.filter(order =>
      order.status === 'OPEN' ||
      order.status === 'PENDING' ||
      order.status === 'PARTIALLY_FILLED'
    );

    return orders;
  }

  public async getPositions(symbol?: string): Promise<Position[]> {
    const params = symbol ? { symbol } : undefined;
    const response = await this.httpClient.get<any>('/v1/perps/positions', { params });

    // Handle Enclave's success/result response format
    if (response.data.success && Array.isArray(response.data.result)) {
      return response.data.result.map((position: any) => this.parsePosition(position));
    }

    // Return empty array if no positions
    return [];
  }

  public async closePosition(symbol: string): Promise<boolean> {
    try {
      await this.httpClient.post(`/v1/perps/positions/${symbol}/close`);
      return true;
    } catch (error) {
      this.logger.error({ error }, 'Failed to close position');
      return false;
    }
  }

  public async getBalance(): Promise<Balance[]> {
    // For perps, use the perps-specific balance endpoint
    try {
      const endpoint = this.subaccountName
        ? `/v1/perps/balance?subaccount=${this.subaccountName}`
        : '/v1/perps/balance';

      const response = await this.httpClient.get(endpoint);

      // Parse perps balance response into our Balance format
      const data = response.data;
      if (data.success && data.result) {

        const result = data.result;
        const walletBalance = new Decimal(result.walletBalance || '0');
        const usedMargin = new Decimal(result.usedMargin || '0');
        const availableMargin = new Decimal(result.availableMargin || '0');

        return [{
          asset: 'USD',
          available: availableMargin, // Use availableMargin as available balance
          locked: usedMargin, // Use usedMargin as locked balance
          total: walletBalance, // Use walletBalance as total balance
        }];
      } else {
        this.logger.warn({ data }, 'Balance API response not successful');
      }
      return [];
    } catch (error: any) {
      this.logger.error({ error }, 'Failed to get balance');
      if (error.response) {
        this.logger.error('Response data:', error.response.data);
        this.logger.error('Response status:', error.response.status);
      }
      return [];
    }
  }

  public async getMarketData(symbol: string): Promise<MarketData> {
    // Return cached WebSocket data instead of REST API call
    const cached = this.marketDataCache.get(symbol);
    if (cached && !cached.last.isZero()) {
      return cached;
    }

    // Wait briefly for WebSocket data to arrive (reduced from 1000ms to 500ms)
    await new Promise(resolve => setTimeout(resolve, 500));

    const afterWait = this.marketDataCache.get(symbol);
    if (afterWait && !afterWait.last.isZero()) {
      return afterWait;
    }

    // Fallback to Binance when Enclave data is unavailable
    try {
      const { BinanceDataService } = await import('../../services/data/BinanceDataService');
      const binanceService = new BinanceDataService();
      const binanceData = await binanceService.getMarketData(symbol);

      this.logger.warn(`Using Binance fallback data for ${symbol}: $${binanceData.last.toString()}`);
      return binanceData;
    } catch (binanceError) {
      const errorMsg = (binanceError as Error).message;
      if (errorMsg.includes('not supported for historical data')) {
        this.logger.debug(`${symbol} not available on Binance, using fallback data`);
      } else {
        this.logger.error({ error: binanceError }, `Binance fallback failed for ${symbol}`);
      }
    }

    // Ultimate fallback: throw error to prevent trading with invalid prices
    throw new Error(`No valid market data available for ${symbol} - cannot trade safely`);
  }

  public async getOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    // Return cached WebSocket data
    const cached = this.orderBookCache.get(symbol);
    if (cached) {
      return {
        ...cached,
        bids: cached.bids.slice(0, depth),
        asks: cached.asks.slice(0, depth),
      };
    }

    // Fallback: return empty book
    return {
      symbol,
      bids: [],
      asks: [],
      timestamp: new Date(),
    };
  }

  public async getTrades(_symbol: string, _limit = 100): Promise<Trade[]> {
    // Return empty array for now - trades come via WebSocket
    return [];
  }

  public async getFundingRate(symbol: string): Promise<FundingRate> {
    const response = await this.httpClient.get<FundingRate>(`/v1/perps/funding/${symbol}`);
    return this.parseFundingRate(response.data);
  }

  private parseOrder(data: any): Order {
    return {
      id: data.orderId,
      symbol: data.market,
      side: data.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      type: data.type === 'limit' ? OrderType.LIMIT : OrderType.MARKET,
      price: data.price ? new Decimal(data.price) : undefined,
      quantity: data.size ? new Decimal(data.size) : new Decimal(0),
      status: this.mapOrderStatus(data.status),
      filledQuantity: data.filledSize ? new Decimal(data.filledSize) : undefined,
      averagePrice: data.averagePrice ? new Decimal(data.averagePrice) : undefined,
      timestamp: data.createdAt ? new Date(data.createdAt) : new Date(),
    };
  }

  private mapOrderStatus(status: string): OrderStatus {
    const normalizedStatus = status?.toLowerCase() || '';
    switch (normalizedStatus) {
      case 'open':
      case 'new':
      case 'pending':
        return OrderStatus.OPEN;
      case 'filled':
      case 'fullyfilled':
      case 'fully_filled':
      case 'complete':
      case 'completed':
      case 'executed':
        return OrderStatus.FILLED;
      case 'partiallyfilled':
      case 'partially_filled':
      case 'partial':
        return OrderStatus.PARTIALLY_FILLED;
      case 'cancelled':
      case 'canceled':
        return OrderStatus.CANCELLED;
      case 'rejected':
      case 'failed':
        return OrderStatus.REJECTED;
      default:
        // IMPORTANT: Default to FILLED for unknown statuses
        // This prevents unknown/closed orders from appearing as "open"
        this.logger.warn(`Unknown order status: "${status}" - treating as FILLED`);
        return OrderStatus.FILLED;
    }
  }

  private parsePosition(data: any): Position {
    return {
      ...data,
      symbol: data.market, // Map market field to symbol for consistency
      quantity: data.netQuantity ? new Decimal(data.netQuantity) : new Decimal(0), // Use netQuantity as it shows the actual position size
      entryPrice: data.entryPrice || data.averageEntryPrice ?
        new Decimal(data.entryPrice || data.averageEntryPrice) : new Decimal(0),
      markPrice: data.markPrice ? new Decimal(data.markPrice) : new Decimal(0),
      unrealizedPnl: data.unrealizedPnl ? new Decimal(data.unrealizedPnl) : new Decimal(0),
      realizedPnl: data.realizedPnl ? new Decimal(data.realizedPnl) : new Decimal(0),
      margin: data.margin || data.usedMargin ? new Decimal(data.margin || data.usedMargin) : new Decimal(0),
      liquidationPrice: data.liquidationPrice ? new Decimal(data.liquidationPrice) : undefined,
      timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
      side: data.direction === 'long' ? OrderSide.BUY : OrderSide.SELL, // Map direction to side
    };
  }

  // Not used - we handle balance parsing inline
  // private parseBalance(data: any): Balance {
  //   return {
  //     ...data,
  //     available: new Decimal(data.available),
  //     locked: new Decimal(data.locked),
  //     total: new Decimal(data.total),
  //   };
  // }

  private parseFundingRate(data: any): FundingRate {
    return {
      symbol: data.symbol,
      rate: new Decimal(data.rate),
      nextFundingTime: new Date(data.nextFundingTime),
    };
  }

  public disconnect(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }
}