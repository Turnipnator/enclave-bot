import express, { Express, Request, Response } from 'express';
import pino from 'pino';

export interface TradingViewAlert {
  ticker: string;        // Symbol like "BTCUSDT" or "BTC-USD.P"
  action: 'buy' | 'sell' | 'close';
  price?: string;
  volume?: string;
  message?: string;
  strategy?: string;
  interval?: string;
  exchange?: string;
}

export class WebhookServer {
  private app: Express;
  private logger = pino({ name: 'WebhookServer' });
  private port: number;
  private alertCallback?: (alert: TradingViewAlert) => Promise<void>;

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Log all incoming requests
    this.app.use((req, _res, next) => {
      this.logger.info({
        method: req.method,
        url: req.url,
        body: req.body,
        headers: req.headers,
      }, 'Incoming request');
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // TradingView webhook endpoint
    this.app.post('/webhook/tradingview', async (req: Request, res: Response) => {
      try {
        const alert = this.parseTradingViewAlert(req.body);
        this.logger.info({ alert }, 'Received TradingView alert');

        if (this.alertCallback) {
          await this.alertCallback(alert);
        }

        res.json({ success: true, message: 'Alert received' });
      } catch (error) {
        this.logger.error({ error, body: req.body }, 'Failed to process TradingView alert');
        res.status(400).json({ success: false, error: 'Invalid alert format' });
      }
    });

    // Manual trigger endpoint for testing
    this.app.post('/trigger/:symbol/:action', async (req: Request, res: Response) => {
      try {
        const { symbol, action } = req.params;
        const { price, volume } = req.body;

        const alert: TradingViewAlert = {
          ticker: symbol,
          action: action as 'buy' | 'sell' | 'close',
          price: price?.toString(),
          volume: volume?.toString(),
          message: 'Manual trigger',
          strategy: 'manual',
        };

        this.logger.info({ alert }, 'Manual trigger received');

        if (this.alertCallback) {
          await this.alertCallback(alert);
        }

        res.json({ success: true, message: 'Trigger executed' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to process manual trigger');
        res.status(500).json({ success: false, error: 'Failed to execute trigger' });
      }
    });
  }

  private parseTradingViewAlert(body: any): TradingViewAlert {
    // TradingView can send alerts in different formats
    // Try to parse common formats

    // Format 1: JSON payload
    if (body.ticker && body.action) {
      return body as TradingViewAlert;
    }

    // Format 2: Plain text message parsing
    if (typeof body === 'string' || body.message) {
      const message = body.message || body;
      const lines = message.split('\n');
      const alert: Partial<TradingViewAlert> = {};

      lines.forEach((line: string) => {
        const [key, value] = line.split(':').map((s: string) => s.trim());
        if (key && value) {
          (alert as any)[key.toLowerCase()] = value;
        }
      });

      if (!alert.ticker || !alert.action) {
        throw new Error('Missing required fields: ticker and action');
      }

      return alert as TradingViewAlert;
    }

    throw new Error('Unable to parse TradingView alert');
  }

  public onAlert(callback: (alert: TradingViewAlert) => Promise<void>): void {
    this.alertCallback = callback;
  }

  public start(): void {
    this.app.listen(this.port, () => {
      this.logger.info(`Webhook server listening on port ${this.port}`);
      this.logger.info(`TradingView webhook URL: http://localhost:${this.port}/webhook/tradingview`);
      this.logger.info(`Manual trigger URL: http://localhost:${this.port}/trigger/{symbol}/{action}`);
    });
  }

  public stop(): void {
    this.logger.info('Stopping webhook server...');
    // Express doesn't provide a built-in way to stop the server
    // You might want to keep track of the server instance if needed
  }

  /**
   * Convert TradingView symbol to Enclave symbol
   */
  public static mapSymbol(tvSymbol: string): string {
    // Map common TradingView symbols to Enclave format
    const symbolMap: Record<string, string> = {
      'BTCUSDT': 'BTC-USD.P',
      'ETHUSDT': 'ETH-USD.P',
      'SOLUSDT': 'SOL-USD.P',
      'AVAXUSDT': 'AVAX-USD.P',
      'BTCUSD': 'BTC-USD.P',
      'ETHUSD': 'ETH-USD.P',
      'SOLUSD': 'SOL-USD.P',
      'AVAXUSD': 'AVAX-USD.P',
    };

    return symbolMap[tvSymbol.toUpperCase()] || tvSymbol;
  }
}