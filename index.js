import axios from "axios";
import cron from "node-cron";
import dotenv from "dotenv";
import { EMA, RSI, MACD, BollingerBands } from "technicalindicators";
import winston from "winston";

dotenv.config();

// ==================== CONFIGURATION ====================
const CONFIG = {
  TELEGRAM: {
    TOKEN: process.env.BOT_TOKEN,
    CHAT_ID: process.env.CHANNEL_ID,
    ADMIN_ID: process.env.ADMIN_CHAT_ID, // For error alerts
  },
  TRADING: {
    PAIRS: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD"],
    TIMEFRAME: "1 Hour (H1)",
    EXPIRY_MIN: 60,
    PRE_ALERT_MIN: 30,
    MIN_CONFIDENCE: 75, // Minimum confidence % to send signal
    RISK_PER_TRADE: 2, // Risk percentage per trade
  },
  PROMO: {
    LINK: process.env.PROMO_LINK || "https://lkjz.pro/6b1d",
    CODE: process.env.PROMO_CODE || "Bossdestiny",
  },
  API: {
    TWELVEDATA_KEY: process.env.TWELVEDATA_KEY,
    FALLBACK_APIS: ["twelvedata", "forexapi"], // Backup data sources
    RATE_LIMIT_DELAY: 1200, // ms between API calls
  },
};

// ==================== LOGGER SETUP ====================
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// ==================== STATE MANAGEMENT ====================
class TradeManager {
  constructor() {
    this.activeTrades = new Map();
    this.tradeHistory = [];
    this.dailyStats = { sent: 0, won: 0, lost: 0, pending: 0 };
    this.lastSignalTime = new Map();
  }

  addTrade(tradeId, tradeData) {
    this.activeTrades.set(tradeId, {
      ...tradeData,
      createdAt: new Date(),
      status: "pending",
    });
    this.dailyStats.sent++;
    this.lastSignalTime.set(tradeData.pair, Date.now());
  }

  updateTrade(tradeId, result) {
    const trade = this.activeTrades.get(tradeId);
    if (trade) {
      trade.status = result.outcome;
      trade.closedAt = new Date();
      trade.exitPrice = result.exitPrice;
      this.tradeHistory.push({ ...trade });
      this.activeTrades.delete(tradeId);
      
      if (result.outcome === "win") this.dailyStats.won++;
      else if (result.outcome === "loss") this.dailyStats.lost++;
    }
  }

  getActiveTrades() {
    return Array.from(this.activeTrades.entries());
  }

  getStats() {
    const total = this.dailyStats.won + this.dailyStats.lost;
    return {
      ...this.dailyStats,
      winRate: total > 0 ? ((this.dailyStats.won / total) * 100).toFixed(2) : 0,
      active: this.activeTrades.size,
    };
  }

  resetDailyStats() {
    this.dailyStats = { sent: 0, won: 0, lost: 0, pending: 0 };
  }
}

const tradeManager = new TradeManager();

// ==================== TELEGRAM SERVICE ====================
class TelegramService {
  constructor() {
    this.baseUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}`;
    this.messageQueue = [];
    this.isProcessing = false;
  }

  async sendMessage(text, options = {}) {
    try {
      const payload = {
        chat_id: options.chatId || CONFIG.TELEGRAM.CHAT_ID,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        ...options,
      };

      const response = await axios.post(`${this.baseUrl}/sendMessage`, payload);
      logger.info(`Message sent successfully`);
      return response.data;
    } catch (error) {
      logger.error("Telegram send failed:", error.message);
      this.queueMessage(text, options);
      throw error;
    }
  }

  async sendPhoto(photoUrl, caption, options = {}) {
    try {
      await axios.post(`${this.baseUrl}/sendPhoto`, {
        chat_id: options.chatId || CONFIG.TELEGRAM.CHAT_ID,
        photo: photoUrl,
        caption: caption,
        parse_mode: "HTML",
      });
    } catch (error) {
      logger.error("Photo send failed:", error.message);
    }
  }

  queueMessage(text, options) {
    this.messageQueue.push({ text, options, retries: 0 });
    if (!this.isProcessing) this.processQueue();
  }

  async processQueue() {
    this.isProcessing = true;
    while (this.messageQueue.length > 0) {
      const item = this.messageQueue[0];
      try {
        await this.sendMessage(item.text, item.options);
        this.messageQueue.shift();
      } catch (error) {
        item.retries++;
        if (item.retries > 3) {
          logger.error("Message failed after 3 retries:", item.text);
          this.messageQueue.shift();
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    this.isProcessing = false;
  }

  async sendAlert(title, message, priority = "normal") {
    const emoji = priority === "high" ? "🚨" : priority === "medium" ? "⚠️" : "ℹ️";
    const text = `
<b>${emoji} ${title}</b>

<pre>${message}</pre>

<i>Timestamp: ${new Date().toISOString()}</i>
    `;
    await this.sendMessage(text, { chatId: CONFIG.TELEGRAM.ADMIN_ID });
  }
}

const telegram = new TelegramService();

// ==================== MARKET DATA SERVICE ====================
class MarketDataService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
  }

  async fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise((r) => setTimeout(r, CONFIG.API.RATE_LIMIT_DELAY));
        const response = await axios.get(url, { timeout: 10000, ...options });
        return response.data;
      } catch (error) {
        if (i === retries - 1) throw error;
        logger.warn(`Retry ${i + 1} for ${url}`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }

  async getForexData(pair) {
    const cacheKey = `${pair}_H1`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      logger.info(`Using cached data for ${pair}`);
      return cached.data;
    }

    try {
      // Try AlphaVantage first
      const data = await this.fetchAlphaVantage(pair);
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      logger.error(`TWELVEDATA for ${pair}:`, error.message);
      // Fallback to alternative source
      return await this.fetchFallbackData(pair);
    }
  }

  async fetchAlphaVantage(pair) {
    if (!CONFIG.TWELVEDATA_KEY) {
      throw new Error("AlphaVantage API key not configured");
    }

    const fromSymbol = pair.slice(0, 3);
    const toSymbol = pair.slice(3) || "USD";
    
    const url = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=1h&outputsize=200&apikey=${process.env.TWELVEDATA_KEY}`;
    
    const data = await this.fetchWithRetry(url);
    const timeSeries = data["Time Series FX (60min)"] || data["Time Series (Digital Currency Hourly)"];
    
    if (!timeSeries) {
      throw new Error("Invalid data format from AlphaVantage");
    }

    return this.parseTimeSeries(timeSeries);
  }

  parseTimeSeries(timeSeries) {
    const entries = Object.entries(timeSeries)
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .slice(-250); // Last 250 candles

    return {
      timestamps: entries.map(([time]) => time),
      opens: entries.map(([, v]) => parseFloat(v["1. open"])),
      highs: entries.map(([, v]) => parseFloat(v["2. high"])),
      lows: entries.map(([, v]) => parseFloat(v["3. low"])),
      closes: entries.map(([, v]) => parseFloat(v["4. close"])),
      volumes: entries.map(([, v]) => parseFloat(v["5. volume"] || 0)),
    };
  }

  async fetchFallbackData(pair) {
    // Implement TwelveData or other fallback
    logger.info(`Using fallback data for ${pair}`);
    // Placeholder for fallback implementation
    throw new Error("Fallback data source not implemented");
  }

  clearCache() {
    this.cache.clear();
  }
}

const marketData = new MarketDataService();

// ==================== TECHNICAL ANALYSIS ====================
class TechnicalAnalyzer {
  analyze(data) {
    const { closes, highs, lows, opens } = data;
    
    if (closes.length < 200) {
      return { valid: false, reason: "Insufficient data" };
    }

    const indicators = this.calculateIndicators(closes, highs, lows);
    const signals = this.generateSignals(indicators, closes);
    const confidence = this.calculateConfidence(indicators, signals, closes);

    return {
      valid: true,
      signal: signals.direction,
      confidence,
      indicators,
      entryPrice: closes[closes.length - 1],
      stopLoss: this.calculateStopLoss(closes, signals.direction),
      takeProfit: this.calculateTakeProfit(closes, signals.direction),
      analysis: signals.reasoning,
    };
  }

  calculateIndicators(closes, highs, lows) {
    return {
      ema20: EMA.calculate({ period: 20, values: closes }),
      ema50: EMA.calculate({ period: 50, values: closes }),
      ema200: EMA.calculate({ period: 200, values: closes }),
      rsi: RSI.calculate({ period: 14, values: closes }),
      rsi7: RSI.calculate({ period: 7, values: closes }),
      bb: BollingerBands.calculate({
        period: 20,
        values: closes,
        stdDev: 2,
      }),
      macd: MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),
    };
  }

  generateSignals(ind, closes) {
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    
    const lastEma20 = ind.ema20[ind.ema20.length - 1];
    const lastEma50 = ind.ema50[ind.ema50.length - 1];
    const lastEma200 = ind.ema200[ind.ema200.length - 1];
    const prevEma50 = ind.ema50[ind.ema50.length - 2];
    const prevEma200 = ind.ema200[ind.ema200.length - 2];
    
    const lastRSI = ind.rsi[ind.rsi.length - 1];
    const lastMACD = ind.macd[ind.macd.length - 1];
    
    const lastBB = ind.bb[ind.bb.length - 1];

    let score = 0;
    let reasoning = [];

    // Trend Analysis
    const trendUp = lastEma50 > lastEma200 && lastEma20 > lastEma50;
    const trendDown = lastEma50 < lastEma200 && lastEma20 < lastEma50;
    
    // EMA Crossover
    const goldenCross = prevEma50 < prevEma200 && lastEma50 > lastEma200;
    const deathCross = prevEma50 > prevEma200 && lastEma50 < lastEma200;

    if (goldenCross) {
      score += 30;
      reasoning.push("Golden Cross detected");
    } else if (deathCross) {
      score -= 30;
      reasoning.push("Death Cross detected");
    }

    // RSI Conditions
    if (lastRSI > 50 && lastRSI < 70) {
      score += 20;
      reasoning.push(`RSI bullish momentum (${lastRSI.toFixed(2)})`);
    } else if (lastRSI < 50 && lastRSI > 30) {
      score -= 20;
      reasoning.push(`RSI bearish momentum (${lastRSI.toFixed(2)})`);
    } else if (lastRSI > 70) {
      score -= 10;
      reasoning.push("RSI overbought");
    } else if (lastRSI < 30) {
      score += 10;
      reasoning.push("RSI oversold");
    }

    // MACD
    if (lastMACD && lastMACD.histogram > 0 && lastMACD.MACD > lastMACD.signal) {
      score += 25;
      reasoning.push("MACD bullish");
    } else if (lastMACD && lastMACD.histogram < 0 && lastMACD.MACD < lastMACD.signal) {
      score -= 25;
      reasoning.push("MACD bearish");
    }

    // Bollinger Bands
    if (lastClose < lastBB.lower) {
      score += 15;
      reasoning.push("Price below lower BB (oversold)");
    } else if (lastClose > lastBB.upper) {
      score -= 15;
      reasoning.push("Price above upper BB (overbought)");
    }

    // Determine direction
    let direction = null;
    if (score >= 40) direction = "CALL";
    else if (score <= -40) direction = "PUT";

    return {
      direction,
      score: Math.abs(score),
      reasoning: reasoning.join(", "),
      trend: trendUp ? "bullish" : trendDown ? "bearish" : "neutral",
    };
  }

  calculateConfidence(indicators, signals, closes) {
    // Multi-factor confidence calculation
    let confidence = Math.min(signals.score, 100);
    
    // Adjust based on trend strength
    const adx = this.calculateADX(closes);
    if (adx > 25) confidence += 10;
    
    // Adjust based on volume (if available)
    // Adjust based on confluence
    const confluence = signals.reasoning.split(",").length;
    confidence += confluence * 5;

    return Math.min(confidence, 100);
  }

  calculateADX(closes) {
    // Simplified ADX calculation
    return 20; // Placeholder
  }

  calculateStopLoss(closes, direction) {
    const atr = this.calculateATR(closes);
    const lastClose = closes[closes.length - 1];
    return direction === "CALL" 
      ? lastClose - (atr * 1.5) 
      : lastClose + (atr * 1.5);
  }

  calculateTakeProfit(closes, direction) {
    const atr = this.calculateATR(closes);
    const lastClose = closes[closes.length - 1];
    return direction === "CALL"
      ? lastClose + (atr * 2)
      : lastClose - (atr * 2);
  }

  calculateATR(closes, period = 14) {
    // Simplified ATR
    const highs = closes.map((c, i) => i > 0 ? Math.max(c, closes[i-1]) : c);
    const lows = closes.map((c, i) => i > 0 ? Math.min(c, closes[i-1]) : c);
    const trs = highs.map((h, i) => h - lows[i]);
    const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    return atr || lastClose * 0.001;
  }
}

const analyzer = new TechnicalAnalyzer();

// ==================== MESSAGE TEMPLATES ====================
class MessageBuilder {
  static preAlert(pair, analysis) {
    const trendEmoji = analysis.signal === "CALL" ? "🟢" : "🔴";
    return `
╔════════════════════════════════════╗
║     ⚠️ PRE-ALERT: SIGNAL INCOMING   ║
╚════════════════════════════════════╝

💱 <b>Asset:</b> <code>${pair}</code>
⏱ <b>Timeframe:</b> ${CONFIG.TRADING.TIMEFRAME}
📊 <b>Expected Direction:</b> ${analysis.signal} ${trendEmoji}
🎯 <b>Confidence:</b> ${analysis.confidence.toFixed(1)}%
📈 <b>Trend:</b> ${analysis.indicators.trend}

<b>Technical Setup:</b>
• ${analysis.analysis}

⏰ <b>Entry in:</b> ${CONFIG.TRADING.PRE_ALERT_MIN} minutes

<i>Prepare your charts and risk management!</i>

<a href="${CONFIG.PROMO.LINK}">📲 Register Trading Account</a>
🎁 Code: <code>${CONFIG.PROMO.CODE}</code>
`;
  }

  static signalAlert(pair, analysis) {
    const trendEmoji = analysis.signal === "CALL" ? "📈" : "📉";
    const directionEmoji = analysis.signal === "CALL" ? "🟢 BUY" : "🔴 SELL";
    
    return `
╔════════════════════════════════════╗
║     🚨 BINARY OPTIONS SIGNAL       ║
╚════════════════════════════════════╝

💱 <b>Asset:</b> <code>${pair}</code>
⏱ <b>Timeframe:</b> ${CONFIG.TRADING.TIMEFRAME}
🎯 <b>Signal:</b> ${directionEmoji} ${trendEmoji}
💪 <b>Confidence:</b> ${analysis.confidence.toFixed(1)}%
⏳ <b>Expiry:</b> ${CONFIG.TRADING.EXPIRY_MIN} minutes

<b>Entry Details:</b>
💵 Entry Price: ${analysis.entryPrice.toFixed(5)}
🛡 Stop Loss: ${analysis.stopLoss.toFixed(5)}
🎯 Take Profit: ${analysis.takeProfit.toFixed(5)}

<b>Strategy:</b> EMA(20/50/200) + RSI(14) + MACD + BB

⚠️ <b>Risk Management:</b>
• Risk only ${CONFIG.TRADING.RISK_PER_TRADE}% per trade
• Use proper position sizing
• Set stop loss immediately

<a href="${CONFIG.PROMO.LINK}">📲 Open Trade Now</a>
🎁 Code: <code>${CONFIG.PROMO.CODE}</code>

<i>Generated: ${new Date().toLocaleTimeString()} UTC</i>
`;
  }

  static resultAlert(trade, result) {
    const outcomeEmoji = result.outcome === "win" ? "✅ PROFIT" : "❌ LOSS";
    const pnl = result.pnl > 0 ? `+${result.pnl.toFixed(2)}%` : `${result.pnl.toFixed(2)}%`;
    
    return `
╔════════════════════════════════════╗
║        📊 SIGNAL RESULT            ║
╚════════════════════════════════════╝

💱 <b>Asset:</b> <code>${trade.pair}</code>
📊 <b>Direction:</b> ${trade.signal}
${outcomeEmoji}

<b>Trade Details:</b>
💵 Entry: ${trade.entryPrice.toFixed(5)}
💵 Exit: ${result.exitPrice.toFixed(5)}
📊 P&L: <code>${pnl}</code>

<b>Session Stats:</b>
📈 Win Rate: ${tradeManager.getStats().winRate}%
🎯 Total Today: ${tradeManager.getStats().sent}

<a href="${CONFIG.PROMO.LINK}">📲 Next Trade</a>
`;
  }

  static dailyReport() {
    const stats = tradeManager.getStats();
    return `
╔════════════════════════════════════╗
║      📈 DAILY PERFORMANCE REPORT    ║
╚════════════════════════════════════╝

📊 <b>Signals Sent:</b> ${stats.sent}
✅ <b>Wins:</b> ${stats.won}
❌ <b>Losses:</b> ${stats.lost}
⏳ <b>Pending:</b> ${stats.active}
🎯 <b>Win Rate:</b> ${stats.winRate}%

<i>Report generated at ${new Date().toLocaleTimeString()}</i>
`;
  }
}

// ==================== MAIN BOT CLASS ====================
class BinarySignalBot {
  constructor() {
    this.isRunning = false;
    this.scheduledTasks = [];
  }

  async start() {
    if (this.isRunning) return;
    
    logger.info("Starting Binary Signal Bot...");
    await this.validateConfig();
    
    this.scheduleTasks();
    this.isRunning = true;
    
    await telegram.sendMessage("🤖 <b>Bot Started</b>\nMonitoring markets for high-probability setups...");
    logger.info("Bot is running");
  }

  async validateConfig() {
    const required = ["BOT_TOKEN", "CHANNEL_ID", "ALPHAVANTAGE_KEY"];
    const missing = required.filter((key) => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
  }

  scheduleTasks() {
    // Main signal scan - every hour at minute 0
    const signalTask = cron.schedule("0 * * * *", () => {
      this.runSignalCycle();
    });

    // Pre-alert scan - every hour at minute 30 (for next hour)
    const preAlertTask = cron.schedule("30 * * * *", () => {
      this.runPreAlertCycle();
    });

    // Result checker - every minute
    const resultTask = cron.schedule("* * * * *", () => {
      this.checkTradeResults();
    });

    // Daily report at 00:00
    const reportTask = cron.schedule("0 0 * * *", () => {
      this.sendDailyReport();
      tradeManager.resetDailyStats();
    });

    // Cache cleanup every 30 minutes
    const cleanupTask = cron.schedule("*/30 * * * *", () => {
      marketData.clearCache();
    });

    this.scheduledTasks = [signalTask, preAlertTask, resultTask, reportTask, cleanupTask];
  }

  async runSignalCycle() {
    logger.info("Starting signal cycle");
    const timestamp = Date.now();
    
    for (const pair of CONFIG.TRADING.PAIRS) {
      try {
        // Check cooldown (avoid duplicate signals)
        const lastSignal = tradeManager.lastSignalTime.get(pair);
        if (lastSignal && timestamp - lastSignal < 3600000) {
          continue;
        }

        const data = await marketData.getForexData(pair);
        const analysis = analyzer.analyze(data);

        if (!analysis.valid || !analysis.signal) {
          logger.info(`No signal for ${pair}: ${analysis.reason || "No setup"}`);
          continue;
        }

        if (analysis.confidence < CONFIG.TRADING.MIN_CONFIDENCE) {
          logger.info(`Signal for ${pair} below confidence threshold: ${analysis.confidence}%`);
          continue;
        }

        const tradeId = `${pair}_${timestamp}`;
        tradeManager.addTrade(tradeId, {
          pair,
          signal: analysis.signal,
          entryPrice: analysis.entryPrice,
          confidence: analysis.confidence,
        });

        const message = MessageBuilder.signalAlert(pair, analysis);
        await telegram.sendMessage(message);
        
        logger.info(`Signal sent for ${pair}: ${analysis.signal} (${analysis.confidence}%)`);

      } catch (error) {
                logger.error(`Error processing ${pair}:`, error);
        await telegram.sendAlert("Signal Error", `Pair: ${pair}\nError: ${error.message}`, "high");
      }
    }
  }

  async runPreAlertCycle() {
    logger.info("Running pre-alert scan");
    // Analyze next potential signals
    for (const pair of CONFIG.TRADING.PAIRS) {
      try {
        const data = await marketData.getForexData(pair);
        const analysis = analyzer.analyze(data);
        
        if (analysis.valid && analysis.signal && analysis.confidence >= CONFIG.TRADING.MIN_CONFIDENCE + 10) {
          const message = MessageBuilder.preAlert(pair, analysis);
          await telegram.sendMessage(message);
        }
      } catch (error) {
        logger.error(`Pre-alert error for ${pair}:`, error);
      }
    }
  }

  async checkTradeResults() {
    const activeTrades = tradeManager.getActiveTrades();
    const now = Date.now();

    for (const [tradeId, trade] of activeTrades) {
      if (trade.expiryTime > now) continue;

      try {
        const data = await marketData.getForexData(trade.pair);
        const currentPrice = data.closes[data.closes.length - 1];
        
        let outcome, pnl;
        const isCall = trade.signal === "CALL";
        
        if (isCall) {
          outcome = currentPrice > trade.entryPrice ? "win" : "loss";
          pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100 * 50; // Leveraged
        } else {
          outcome = currentPrice < trade.entryPrice ? "win" : "loss";
          pnl = ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100 * 50;
        }

        tradeManager.updateTrade(tradeId, {
          outcome,
          exitPrice: currentPrice,
          pnl,
        });

        const message = MessageBuilder.resultAlert(trade, { outcome, exitPrice: currentPrice, pnl });
        await telegram.sendMessage(message);

      } catch (error) {
        logger.error(`Error checking result for ${tradeId}:`, error);
      }
    }
  }

  async sendDailyReport() {
    const message = MessageBuilder.dailyReport();
    await telegram.sendMessage(message);
  }

  stop() {
    this.scheduledTasks.forEach((task) => task.stop());
    this.isRunning = false;
    logger.info("Bot stopped");
  }
}

// ==================== INITIALIZATION ====================
const bot = new BinarySignalBot();

// Graceful shutdown
process.on("SIGTERM", () => bot.stop());
process.on("SIGINT", () => bot.stop());

// Start the bot
bot.start().catch((error) => {
  logger.error("Failed to start bot:", error);
  process.exit(1);
});

export default bot;
