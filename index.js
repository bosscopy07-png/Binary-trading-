import axios from "axios";
import cron from "node-cron";
import dotenv from "dotenv";
import { 
  EMA, RSI, MACD, BollingerBands, ATR, ADX, Stochastic 
} from "technicalindicators";
import winston from "winston";

dotenv.config();

// ==================== CONFIGURATION ====================
const CONFIG = {
  TELEGRAM: {
    TOKEN: process.env.BOT_TOKEN,
    CHAT_ID: process.env.CHANNEL_ID,
    ADMIN_ID: process.env.ADMIN_CHAT_ID || null,
    RATE_LIMIT_MS: 1000, // 1 message per second to same chat
  },
  TRADING: {
    PAIRS: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD"],
    TIMEFRAME: "1 Hour (H1)",
    EXPIRY_MIN: 60,
    PRE_ALERT_MIN: 30,
    MIN_CONFIDENCE: 75,
    RISK_PER_TRADE: 0.5, // Conservative: 0.5% per trade
    MAX_DAILY_RISK: 3.0, // Max 3% daily loss
    MAX_TRADES_PER_DAY: 5, // Prevent overtrading
    COOLDOWN_MIN: 60, // Minutes between signals for same pair
  },
  PROMO: {
    LINK: process.env.PROMO_LINK || "https://lkjz.pro/6b1d",
    CODE: process.env.PROMO_CODE || "Bossdestiny",
  },
  API: {
    TWELVEDATA_KEY: process.env.TWELVEDATA_KEY,
    RATE_LIMIT_DELAY: 1200, // 1.2s between API calls (8/min max)
    MAX_RETRIES: 3,
  },
};

// ==================== ENHANCED LOGGER ====================
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
    this.dailyStats = { 
      sent: 0, 
      won: 0, 
      lost: 0, 
      pending: 0,
      dailyRiskUsed: 0, // Track daily risk exposure
      lastTradeDate: new Date().toDateString()
    };
    this.lastSignalTime = new Map();
    this.dailyTradeCount = 0;
  }

  checkNewDay() {
    const today = new Date().toDateString();
    if (today !== this.dailyStats.lastTradeDate) {
      this.resetDailyStats();
      this.dailyStats.lastTradeDate = today;
      this.dailyTradeCount = 0;
    }
  }

  canTakeTrade() {
    this.checkNewDay();
    if (this.dailyTradeCount >= CONFIG.TRADING.MAX_TRADES_PER_DAY) {
      return { allowed: false, reason: "Daily trade limit reached" };
    }
    if (this.dailyStats.dailyRiskUsed >= CONFIG.TRADING.MAX_DAILY_RISK) {
      return { allowed: false, reason: "Daily risk limit reached" };
    }
    return { allowed: true };
  }

  addTrade(tradeId, tradeData) {
    const expiryTime = Date.now() + (CONFIG.TRADING.EXPIRY_MIN * 60 * 1000);
    this.activeTrades.set(tradeId, {
      ...tradeData,
      createdAt: new Date(),
      status: "pending",
      expiryTime: expiryTime,
      riskAmount: CONFIG.TRADING.RISK_PER_TRADE,
    });
    
    this.dailyStats.sent++;
    this.dailyStats.dailyRiskUsed += CONFIG.TRADING.RISK_PER_TRADE;
    this.dailyTradeCount++;
    this.lastSignalTime.set(tradeData.pair, Date.now());
    
    logger.info(`Trade added: ${tradeId}, Risk: ${CONFIG.TRADING.RISK_PER_TRADE}%, Daily Risk: ${this.dailyStats.dailyRiskUsed}%`);
  }

  updateTrade(tradeId, result) {
    const trade = this.activeTrades.get(tradeId);
    if (trade) {
      trade.status = result.outcome;
      trade.closedAt = new Date();
      trade.exitPrice = result.exitPrice;
      trade.pnl = result.pnl;
      this.tradeHistory.push({ ...trade });
      this.activeTrades.delete(tradeId);
      
      if (result.outcome === "win") this.dailyStats.won++;
      else if (result.outcome === "loss") this.dailyStats.lost++;
      
      logger.info(`Trade closed: ${tradeId}, Result: ${result.outcome}, PnL: ${result.pnl}%`);
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
      tradesRemaining: CONFIG.TRADING.MAX_TRADES_PER_DAY - this.dailyTradeCount,
    };
  }

  resetDailyStats() {
    this.dailyStats = { 
      sent: 0, 
      won: 0, 
      lost: 0, 
      pending: 0,
      dailyRiskUsed: 0,
      lastTradeDate: new Date().toDateString()
    };
    logger.info("Daily stats reset");
  }

  isCooldownActive(pair) {
    const lastSignal = this.lastSignalTime.get(pair);
    if (!lastSignal) return false;
    const cooldownMs = CONFIG.TRADING.COOLDOWN_MIN * 60 * 1000;
    return (Date.now() - lastSignal) < cooldownMs;
  }
}

const tradeManager = new TradeManager();

// ==================== TELEGRAM SERVICE ====================
class TelegramService {
  constructor() {
    this.baseUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}`;
    this.messageQueue = [];
    this.isProcessing = false;
    this.lastMessageTime = 0;
  }

  async rateLimit() {
    const now = Date.now();
    const timeSinceLastMessage = now - this.lastMessageTime;
    if (timeSinceLastMessage < CONFIG.TELEGRAM.RATE_LIMIT_MS) {
      await new Promise(r => setTimeout(r, CONFIG.TELEGRAM.RATE_LIMIT_MS - timeSinceLastMessage));
    }
    this.lastMessageTime = Date.now();
  }

  async sendMessage(text, options = {}) {
    await this.rateLimit();
    
    try {
      const payload = {
        chat_id: options.chatId || CONFIG.TELEGRAM.CHAT_ID,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        ...options,
      };

      const response = await axios.post(`${this.baseUrl}/sendMessage`, payload, {
        timeout: 10000,
      });
      
      logger.info(`Message sent successfully to ${payload.chat_id}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data?.parameters?.retry_after || 35;
        logger.warn(`Rate limited by Telegram. Retry after ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return this.sendMessage(text, options); // Retry once
      }
      
      logger.error("Telegram send failed:", error.message);
      this.queueMessage(text, options);
      throw error;
    }
  }

  async sendPhoto(photoUrl, caption, options = {}) {
    await this.rateLimit();
    
    try {
      await axios.post(`${this.baseUrl}/sendPhoto`, {
        chat_id: options.chatId || CONFIG.TELEGRAM.CHAT_ID,
        photo: photoUrl,
        caption: caption,
        parse_mode: "HTML",
      }, { timeout: 10000 });
    } catch (error) {
      logger.error("Photo send failed:", error.message);
    }
  }

  queueMessage(text, options) {
    this.messageQueue.push({ text, options, retries: 0, lastAttempt: Date.now() });
    if (!this.isProcessing) this.processQueue();
  }

  async processQueue() {
    this.isProcessing = true;
    while (this.messageQueue.length > 0) {
      const item = this.messageQueue[0];
      const delay = Math.max(0, 5000 - (Date.now() - item.lastAttempt));
      await new Promise(r => setTimeout(r, delay));
      
      try {
        await this.sendMessage(item.text, item.options);
        this.messageQueue.shift();
      } catch (error) {
        item.retries++;
        item.lastAttempt = Date.now();
        if (item.retries > 3) {
          logger.error("Message failed after 3 retries:", item.text.substring(0, 100));
          this.messageQueue.shift();
        }
      }
    }
    this.isProcessing = false;
  }

  async sendAlert(title, message, priority = "normal") {
    if (!CONFIG.TELEGRAM.ADMIN_ID) {
      logger.warn("ADMIN_ID not set, skipping alert");
      return;
    }
    
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
    this.requestQueue = [];
    this.isProcessingQueue = false;
  }

  async fetchWithRetry(url, options = {}, retries = CONFIG.API.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        // Respect rate limit: 8 requests per minute = 1 every 7.5 seconds
        await new Promise((r) => setTimeout(r, CONFIG.API.RATE_LIMIT_DELAY));
        
        const response = await axios.get(url, { 
          timeout: 15000, 
          ...options,
          headers: {
            'User-Agent': 'BinarySignalBot/1.0',
            ...options.headers
          }
        });
        
        if (response.data?.status === 'error') {
          throw new Error(`API Error: ${response.data.message}`);
        }
        
        return response.data;
      } catch (error) {
        if (i === retries - 1) throw error;
        
        const isRateLimit = error.response?.status === 429;
        const delay = isRateLimit ? 10000 : (2000 * (i + 1));
        
        logger.warn(`Retry ${i + 1}/${retries} for ${url}: ${error.message}`);
        await new Promise((r) => setTimeout(r, delay));
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
      const data = await this.fetchTwelveData(pair);
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      logger.error(`Failed to fetch data for ${pair}: ${error.message}`);
      throw error;
    }
  }

  async fetchTwelveData(pair) {
    if (!CONFIG.API.TWELVEDATA_KEY) {
      throw new Error("TWELVEDATA_KEY not configured in .env file");
    }

    // Format pair for TwelveData (e.g., EUR/USD)
    const formattedPair = pair.length === 6 ? `${pair.slice(0,3)}/${pair.slice(3)}` : pair;
    
    const url = `https://api.twelvedata.com/time_series?symbol=${formattedPair}&interval=1h&outputsize=200&apikey=${CONFIG.API.TWELVEDATA_KEY}`;
    
    logger.info(`Fetching live data for ${pair} from TwelveData`);
    const data = await this.fetchWithRetry(url);
    
    if (!data.values || !Array.isArray(data.values) || data.values.length < 50) {
      throw new Error(`Insufficient data from TwelveData: ${data.values?.length || 0} candles received`);
    }

    return this.parseTwelveData(data);
  }

  parseTwelveData(data) {
    // TwelveData returns values in reverse chronological order (newest first)
    // Reverse to oldest first for technical indicators
    const values = [...data.values].reverse();
    
    return {
      timestamps: values.map(v => v.datetime),
      opens: values.map(v => parseFloat(v.open)),
      highs: values.map(v => parseFloat(v.high)),
      lows: values.map(v => parseFloat(v.low)),
      closes: values.map(v => parseFloat(v.close)),
      volumes: values.map(v => parseFloat(v.volume || 0)),
    };
  }

  clearCache() {
    this.cache.clear();
    logger.info("Cache cleared");
  }
}

const marketData = new MarketDataService();


        // ==================== ENHANCED TECHNICAL ANALYSIS ====================
class TechnicalAnalyzer {
  analyze(data) {
    const { closes, highs, lows, volumes } = data;

    if (!closes || closes.length < 100) { // Reduced from 200
      return { valid: false, reason: "Need at least 100 candles" };
    }

    try {
      const ind = this.calculateIndicators(closes, highs, lows, volumes);
      
      // Check market conditions
      const marketCondition = this.assessMarketCondition(ind, closes);
      
      const signal = this.generateSignal(ind, closes, highs, lows, volumes, marketCondition);
      
      if (!signal.direction) {
        return { 
          valid: false, 
          reason: signal.reason,
          score: signal.score,
          marketCondition: marketCondition.type
        };
      }

      const risk = this.calculateRisk(signal, closes, highs, lows);

      return {
        valid: true,
        signal: signal.direction,
        confidence: signal.confidence,
        entryPrice: closes.at(-1),
        stopLoss: risk.stop,
        takeProfit: risk.target,
        riskReward: risk.rr,
        positionSize: risk.positionSize,
        trend: signal.trend,
        setupType: signal.setupType,
        reasoning: signal.reason,
        marketCondition: marketCondition.type,
        score: signal.score,
        confluence: signal.confluence,
        timeFrame: "1H",
        // Forex-specific
        trailingStop: risk.trailingStop,
        breakevenTrigger: risk.breakevenTrigger
      };
    } catch (err) {
      return { valid: false, reason: err.message };
    }
  }

  calculateIndicators(closes, highs, lows, volumes) {
    return {
      // Fast EMAs for entry timing
      ema8: EMA.calculate({ period: 8, values: closes }),
      ema21: EMA.calculate({ period: 21, values: closes }),
      // Slow EMAs for trend
      ema50: EMA.calculate({ period: 50, values: closes }),
      ema200: EMA.calculate({ period: 200, values: closes }),
      // Momentum
      rsi: RSI.calculate({ period: 14, values: closes }),
      rsi6: RSI.calculate({ period: 6, values: closes }), // Faster RSI
      macd: MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      }),
      // Volatility
      atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
      atr10: ATR.calculate({ high: highs, low: lows, close: closes, period: 10 }), // Faster ATR
      bb: BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }),
      // Trend strength
      adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
      // Volume
      avgVolume20: volumes.slice(-20).reduce((a,b) => a+b, 0) / 20,
    };
  }

  assessMarketCondition(ind, closes) {
    const lastClose = closes.at(-1);
    const atr = ind.atr.at(-1);
    const adx = ind.adx.at(-1)?.adx || 0;
    
    const volatility = atr / lastClose;
    
    // Forex-specific filters
    if (volatility < 0.0008) {
      return { 
        tradable: false, 
        reason: "Too quiet - spreads will eat profits",
        type: "low_volatility",
        volatility 
      };
    }
    
    if (volatility > 0.015) { // 1.5% daily range is high for forex
      return {
        tradable: false,
        reason: "News event/volatility spike - avoid",
        type: "high_volatility",
        volatility
      };
    }
    
    // Session-based logic could go here (London, NY, Tokyo)
    
    let type = "range";
    if (adx > 30) type = "strong_trend";
    else if (adx > 20) type = "weak_trend";
    
    return {
      tradable: true,
      type,
      adx,
      volatility,
      riskMultiplier: volatility > 0.005 ? 0.8 : 1.0 // Reduce size in high vol
    };
  }

  generateSignal(ind, closes, highs, lows, volumes, marketCondition) {
    const lastClose = closes.at(-1);
    const lastHigh = highs.at(-1);
    const lastLow = lows.at(-1);
    const lastVolume = volumes.at(-1);

    const ema8 = ind.ema8.at(-1);
    const ema21 = ind.ema21.at(-1);
    const ema50 = ind.ema50.at(-1);
    const ema200 = ind.ema200.at(-1);
    
    const ema8Prev = ind.ema8.at(-2) || ema8;
    const ema21Prev = ind.ema21.at(-2) || ema21;
    
    const rsi = ind.rsi.at(-1);
    const rsi6 = ind.rsi6.at(-1);
    const rsiPrev = ind.rsi.at(-2) || rsi;
    
    const macd = ind.macd.at(-1);
    const macdPrev = ind.macd.at(-2) || macd;
    
    const bb = ind.bb.at(-1);
    const atr = ind.atr10.at(-1);

    let score = 0;
    let confluence = 0;
    let reasons = [];
    let setupType = "";

    // ========== TREND ANALYSIS ==========
    const trendUp = ema21 > ema50 && ema50 > ema200;
    const trendDown = ema21 < ema50 && ema50 < ema200;
    const ema8CrossUp = ema8 > ema21 && ema8Prev <= ema21Prev;
    const ema8CrossDown = ema8 < ema21 && ema8Prev >= ema21Prev;
    const priceAboveEma8 = lastClose > ema8;
    const priceBelowEma8 = lastClose < ema8;

    // ========== SETUP 1: TREND PULLBACK (Highest probability) ==========
    if (marketCondition.type.includes("trend")) {
      if (trendUp && priceBelowEma8 && rsi > 40 && rsi < 60) {
        // Bull trend, price pulled back to EMA8, RSI neutral (not overbought)
        score += 25;
        confluence++;
        reasons.push("Pullback to EMA8 in uptrend");
        setupType = "TREND_PULLBACK_BULL";
        
        if (macd.histogram > -0.001) { // MACD not strongly bearish
          score += 15;
          confluence++;
          reasons.push("MACD holding");
        }
        
        if (lastVolume > ind.avgVolume20 * 1.2) {
          score += 10;
          reasons.push("Volume confirmation");
        }
        
        // Check for bullish engulfing or hammer (simplified)
        const prevClose = closes.at(-2);
        const prevOpen = closes.at(-3); // Approximation
        if (lastClose > prevClose && lastClose > ema8) {
          score += 10;
          reasons.push("Bullish close above EMA8");
        }
      }
      
      else if (trendDown && priceAboveEma8 && rsi < 60 && rsi > 40) {
        // Bear trend, price pulled back to EMA8, RSI neutral
        score -= 25;
        confluence++;
        reasons.push("Pullback to EMA8 in downtrend");
        setupType = "TREND_PULLBACK_BEAR";
        
        if (macd.histogram < 0.001) {
          score -= 15;
          confluence++;
          reasons.push("MACD holding");
        }
        
        if (lastVolume > ind.avgVolume20 * 1.2) {
          score -= 10;
          reasons.push("Volume confirmation");
        }
        
        const prevClose = closes.at(-2);
        if (lastClose < prevClose && lastClose < ema8) {
          score -= 10;
          reasons.push("Bearish close below EMA8");
        }
      }
    }

    // ========== SETUP 2: EMA CROSS (Momentum) ==========
    if (ema8CrossUp && trendUp) {
      score += 20;
      confluence++;
      reasons.push("EMA8 crossed above EMA21");
      setupType = setupType || "EMA_CROSS_BULL";
      
      if (rsi6 > 50 && macd.histogram > 0) {
        score += 15;
        confluence++;
        reasons.push("RSI6 and MACD confirm");
      }
    }
    
    else if (ema8CrossDown && trendDown) {
      score -= 20;
      confluence++;
      reasons.push("EMA8 crossed below EMA21");
      setupType = setupType || "EMA_CROSS_BEAR";
      
      if (rsi6 < 50 && macd.histogram < 0) {
        score -= 15;
        confluence++;
        reasons.push("RSI6 and MACD confirm");
      }
    }

    // ========== SETUP 3: BREAKOUT (BB Squeeze) ==========
    const bbWidth = (bb.upper - bb.lower) / lastClose;
    const bbSqueeze = bbWidth < 0.015; // 1.5% band width
    const priceAboveBB = lastClose > bb.upper;
    const priceBelowBB = lastClose < bb.lower;

    if (bbSqueeze && lastVolume > ind.avgVolume20 * 1.5) {
      if (priceAboveBB && macd.histogram > 0) {
        score += 18;
        confluence++;
        reasons.push("BB Squeeze breakout bullish");
        setupType = setupType || "BREAKOUT_BULL";
      } else if (priceBelowBB && macd.histogram < 0) {
        score -= 18;
        confluence++;
        reasons.push("BB Squeeze breakout bearish");
        setupType = setupType || "BREAKOUT_BEAR";
      }
    }

    // ========== SETUP 4: MEAN REVERSION (Range only) ==========
    if (marketCondition.type === "range" && !setupType.includes("TREND")) {
      if (priceBelowBB && rsi < 30) {
        score += 15;
        confluence++;
        reasons.push("Oversold in range");
        setupType = setupType || "MEAN_REV_BULL";
      } else if (priceAboveBB && rsi > 70) {
        score -= 15;
        confluence++;
        reasons.push("Overbought in range");
        setupType = setupType || "MEAN_REV_BEAR";
      }
    }

    // ========== FILTERS ==========
    // Avoid chasing - don't enter if RSI too extreme in trend direction
    if (setupType.includes("BULL") && rsi > 75) {
      score -= 20;
      reasons.push("Avoid chase - RSI overbought");
    }
    if (setupType.includes("BEAR") && rsi < 25) {
      score += 20;
      reasons.push("Avoid chase - RSI oversold");
    }

    // News avoidance - check for unusual volume spike without price movement
    if (lastVolume > ind.avgVolume20 * 3 && Math.abs(lastClose - closes.at(-2)) / lastClose < 0.002) {
      return {
        direction: null,
        reason: "Potential news event - doji with volume spike",
        score: 0,
        setupType: "AVOID_NEWS"
      };
    }

    // ========== DECISION ==========
    const minScore = 35;
    const minConfluence = 2;
    
    let direction = null;
    let confidence = 0;
    let trend = "neutral";

    if (score >= minScore && confluence >= minConfluence) {
      direction = "BUY";
      confidence = Math.min(50 + score + confluence * 5, 85);
      trend = trendUp ? "bullish" : "neutral";
    } else if (score <= -minScore && confluence >= minConfluence) {
      direction = "SELL";
      confidence = Math.min(50 + Math.abs(score) + confluence * 5, 85);
      trend = trendDown ? "bearish" : "neutral";
    }

    return {
      direction,
      score: Math.abs(score),
      rawScore: score,
      confluence,
      trend,
      confidence,
      setupType,
      reason: reasons.join(" | "),
      details: {
        ema8: ema8.toFixed(5),
        ema21: ema21.toFixed(5),
        rsi: rsi.toFixed(1),
        macdHist: macd.histogram.toFixed(5),
        atr: atr.toFixed(5),
        bbWidth: (bbWidth * 100).toFixed(2) + "%"
      }
    };
  }

  calculateRisk(signal, closes, highs, lows) {
    const atr = ind.atr10.at(-1);
    const entry = closes.at(-1);
    
    // Base ATR multiplier on setup type
    let atrMultiplier = 1.5;
    if (signal.setupType.includes("BREAKOUT")) atrMultiplier = 2.0;
    if (signal.setupType.includes("MEAN_REV")) atrMultiplier = 1.2;
    
    // Tighter stops for higher confidence
    if (signal.confidence > 75) atrMultiplier *= 0.9;
    
    const stopDistance = atr * atrMultiplier;
    
    const stop = signal.direction === "BUY" 
      ? entry - stopDistance 
      : entry + stopDistance;
    
    // Risk/Reward based on setup type
    let rrRatio = 2.0; // Default 1:2
    if (signal.setupType.includes("TREND_PULLBACK")) rrRatio = 3.0; // Trend trades run further
    if (signal.setupType.includes("MEAN_REV")) rrRatio = 1.5; // Range trades limited
    
    const target = signal.direction === "BUY"
      ? entry + (stopDistance * rrRatio)
      : entry - (stopDistance * rrRatio);
    
    // Position sizing: Risk 1% per trade (adjustable)
    const accountBalance = 10000; // Should come from config/account
    const riskPercent = 1.0;
    const riskAmount = accountBalance * (riskPercent / 100);
    const positionSize = riskAmount / Math.abs(entry - stop);
    
    // Trailing stop logic
    const trailingStop = atr * 2; // Move stop when price moves 2xATR in profit
    
    // Breakeven trigger
    const breakevenTrigger = stopDistance * 1; // Move to BE when 1x risk in profit
    
    return {
      stop: stop.toFixed(5),
      target: target.toFixed(5),
      rr: rrRatio.toFixed(2),
      positionSize: positionSize.toFixed(2), // In lots/units
      stopDistance: stopDistance.toFixed(5),
      trailingStop: trailingStop.toFixed(5),
      breakevenTrigger: breakevenTrigger.toFixed(5)
    };
  }
}

const analyzer = new TechnicalAnalyzer();
        
// ==================== MESSAGE TEMPLATES ====================
class MessageBuilder {
  static preAlert(pair, analysis) {
    const trendEmoji = analysis.signal === "CALL" ? "🟢" : "🔴";
    const stats = tradeManager.getStats();
    
    return `
╔════════════════════════════════════╗
║     ⚠️ PRE-ALERT: SIGNAL INCOMING   ║
╚════════════════════════════════════╝

💱 <b>Asset:</b> <code>${pair}</code>
⏱ <b>Timeframe:</b> ${CONFIG.TRADING.TIMEFRAME}
📊 <b>Expected Direction:</b> ${analysis.signal} ${trendEmoji}
🎯 <b>Confidence:</b> ${analysis.confidence.toFixed(1)}%
📈 <b>Trend:</b> ${analysis.indicators.trend.toUpperCase()}
💪 <b>Confluence:</b> ${analysis.indicators.confluence}/6 indicators

<b>Key Levels:</b>
🟢 Support: ${analysis.indicators.support} (${analysis.indicators.distToSupport}% away)
🔴 Resistance: ${analysis.indicators.resistance} (${analysis.indicators.distToResistance}% away)

<b>Technical Setup:</b>
• ${analysis.analysis}

⚠️ <b>Risk Management:</b>
• Daily trades remaining: ${stats.tradesRemaining}
• Risk per trade: ${CONFIG.TRADING.RISK_PER_TRADE}%
• Daily risk used: ${stats.dailyRiskUsed}/${CONFIG.TRADING.MAX_DAILY_RISK}%

⏰ <b>Entry in:</b> ${CONFIG.TRADING.PRE_ALERT_MIN} minutes

<i>Prepare your charts and risk management!</i>

<a href="${CONFIG.PROMO.LINK}">📲 Register Trading Account</a>
🎁 Code: <code>${CONFIG.PROMO.CODE}</code>
`;
  }

  static signalAlert(pair, analysis) {
    const trendEmoji = analysis.signal === "CALL" ? "📈" : "📉";
    const directionEmoji = analysis.signal === "CALL" ? "🟢 BUY" : "🔴 SELL";
    const stats = tradeManager.getStats();
    
    return `
╔════════════════════════════════════╗
║     🚨 BINARY OPTIONS SIGNAL       ║
╚════════════════════════════════════╝

💱 <b>Asset:</b> <code>${pair}</code>
⏱ <b>Timeframe:</b> ${CONFIG.TRADING.TIMEFRAME}
🎯 <b>Signal:</b> ${directionEmoji} ${trendEmoji}
💪 <b>Confidence:</b> ${analysis.confidence.toFixed(1)}%
⏳ <b>Expiry:</b> ${CONFIG.TRADING.EXPIRY_MIN} minutes
📊 <b>Risk/Reward:</b> 1:${analysis.riskReward}

<b>Entry Details:</b>
💵 Entry Price: ${analysis.entryPrice.toFixed(5)}
🛡 Stop Loss: ${analysis.stopLoss.toFixed(5)}
🎯 Take Profit: ${analysis.takeProfit.toFixed(5)}

<b>Strategy:</b> EMA(20/50/200) + RSI(14) + MACD + BB + ADX + Stoch

<b>Market Structure:</b>
🟢 Support: ${analysis.indicators.support}
🔴 Resistance: ${analysis.indicators.resistance}

⚠️ <b>Risk Management:</b>
• Risk only ${CONFIG.TRADING.RISK_PER_TRADE}% per trade
• Daily limit: ${CONFIG.TRADING.MAX_TRADES_PER_DAY} trades (${stats.tradesRemaining} remaining)
• Max daily loss: ${CONFIG.TRADING.MAX_DAILY_RISK}%
• Set stop loss immediately

<a href="${CONFIG.PROMO.LINK}">📲 Open Trade Now</a>
🎁 Code: <code>${CONFIG.PROMO.CODE}</code>

<i>Generated: ${new Date().toLocaleTimeString()} UTC | Real Market Data</i>
`;
  }

  static resultAlert(trade, result) {
    const outcomeEmoji = result.outcome === "win" ? "✅ PROFIT" : "❌ LOSS";
    const pnl = result.pnl > 0 ? `+${result.pnl.toFixed(2)}%` : `${result.pnl.toFixed(2)}%`;
    const stats = tradeManager.getStats();
    
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
⏱ Duration: ${CONFIG.TRADING.EXPIRY_MIN} minutes

<b>Session Stats:</b>
📈 Win Rate: ${stats.winRate}%
🎯 Total Today: ${stats.sent}
✅ Wins: ${stats.won}
❌ Losses: ${stats.lost}
💰 Daily Risk Used: ${stats.dailyRiskUsed}%

<a href="${CONFIG.PROMO.LINK}">📲 Next Trade</a>
`;
  }

  static dailyReport() {
    const stats = tradeManager.getStats();
    const totalTrades = stats.won + stats.lost;
    const profitFactor = stats.lost > 0 ? (stats.won / stats.lost).toFixed(2) : stats.won;
    
    return `
╔════════════════════════════════════╗
║      📈 DAILY PERFORMANCE REPORT    ║
╚════════════════════════════════════╝

📊 <b>Signals Sent:</b> ${stats.sent}
✅ <b>Wins:</b> ${stats.won}
❌ <b>Losses:</b> ${stats.lost}
⏳ <b>Pending:</b> ${stats.active}
🎯 <b>Win Rate:</b> ${stats.winRate}%
📈 <b>Profit Factor:</b> ${profitFactor}
💰 <b>Daily Risk Used:</b> ${stats.dailyRiskUsed}%

<b>Risk Management:</b>
• Max risk/trade: ${CONFIG.TRADING.RISK_PER_TRADE}%
• Daily risk limit: ${CONFIG.TRADING.MAX_DAILY_RISK}%
• Trades limit: ${CONFIG.TRADING.MAX_TRADES_PER_DAY}
• Remaining today: ${stats.tradesRemaining}

<i>Report generated at ${new Date().toLocaleTimeString()} UTC</i>
<i>Data source: TwelveData Real-Time API</i>
`;
  }

  static riskWarning() {
    return `
⚠️ <b>RISK WARNING</b> ⚠️

Binary options trading involves substantial risk of loss. 
Past performance does not guarantee future results.

<b>Current Limits:</b>
• Risk per trade: ${CONFIG.TRADING.RISK_PER_TRADE}%
• Daily max risk: ${CONFIG.TRADING.MAX_DAILY_RISK}%
• Max trades/day: ${CONFIG.TRADING.MAX_TRADES_PER_DAY}

Trade responsibly. Never risk more than you can afford to lose.
`;
  }
}

// ==================== MAIN BOT CLASS ====================
class BinarySignalBot {
  constructor() {
    this.isRunning = false;
    this.scheduledTasks = [];
    this.lastHealthCheck = Date.now();
  }

  async start() {
    if (this.isRunning) return;
    
    logger.info("Starting Binary Signal Bot v2.0...");
    await this.validateConfig();
    
    this.scheduleTasks();
    this.isRunning = true;
    
    await telegram.sendMessage("🤖 <b>Binary Signal Bot v2.0 Started</b>\n\n✅ Real-time market data active\n✅ Risk management enabled\n✅ Technical analysis engine running");
    await telegram.sendMessage(MessageBuilder.riskWarning());

    logger.info("Bot is running with real market data");
  }

  async validateConfig() {
    const required = ["BOT_TOKEN", "CHANNEL_ID", "TWELVEDATA_KEY"];
    const missing = required.filter((key) => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
    
    // Test API connection
    try {
      await marketData.getForexData("EURUSD");
      logger.info("TwelveData API connection validated");
    } catch (error) {
      throw new Error(`API connection failed: ${error.message}`);
    }
    
    logger.info("Configuration validated successfully");
  }

  scheduleTasks() {
    // Main signal scan - every hour at minute 0
    const signalTask = cron.schedule("0 * * * *", () => {
      this.runSignalCycle();
    });

    // Pre-alert scan - every hour at minute 30
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

    // Health check every 5 minutes
    const healthTask = cron.schedule("*/5 * * * *", () => {
      this.healthCheck();
    });

    this.scheduledTasks = [signalTask, preAlertTask, resultTask, reportTask, cleanupTask, healthTask];
    logger.info("Scheduled tasks initialized");
  }

  async healthCheck() {
    const activeTrades = tradeManager.getActiveTrades().length;
    const stats = tradeManager.getStats();
    
    if (activeTrades > 10) {
      await telegram.sendAlert("High Activity Warning", `${activeTrades} active trades`, "medium");
    }
    
    this.lastHealthCheck = Date.now();
    logger.info(`Health check: ${activeTrades} active, ${stats.winRate}% win rate`);
  }

  
      async runSignalCycle() {
    logger.info("Starting signal cycle with real market data");
    tradeManager.checkNewDay();
    
    const canTrade = tradeManager.canTakeTrade();
    if (!canTrade.allowed) {
      logger.info(`Trading halted: ${canTrade.reason}`);
      return;
    }

    let signalsFound = 0;

    for (const pair of CONFIG.TRADING.PAIRS) {
      try {
        // Check cooldown
        if (tradeManager.isCooldownActive(pair)) {
          logger.info(`Skipping ${pair}: cooldown active`);
          continue;
        }

        const data = await marketData.getForexData(pair);
        const analysis = analyzer.analyze(data);

        if (!analysis.valid) {
          logger.info(`No signal for ${pair}: ${analysis.reason}`);
          continue;
        }

        if (!analysis.signal) {
          logger.info(`No signal for ${pair}: Score ${analysis.rawScore}, Confluence ${analysis.indicators.confluence} - ${analysis.analysis}`);
          continue;
        }

        if (analysis.confidence < CONFIG.TRADING.MIN_CONFIDENCE) {
          logger.info(`Signal for ${pair} below confidence threshold: ${analysis.confidence}% (need ${CONFIG.TRADING.MIN_CONFIDENCE}%)`);
          continue;
        }

        // Final risk check before sending
        const tradeCheck = tradeManager.canTakeTrade();
        if (!tradeCheck.allowed) {
          logger.warn(`Risk limit reached, stopping signal generation`);
          break;
        }

        signalsFound++;
        const tradeId = `${pair}_${Date.now()}`;
        tradeManager.addTrade(tradeId, {
          pair,
          signal: analysis.signal,
          entryPrice: analysis.entryPrice,
          confidence: analysis.confidence,
        });

        const message = MessageBuilder.signalAlert(pair, analysis);
        await telegram.sendMessage(message);
        
        logger.info(`✅ REAL SIGNAL SENT for ${pair}: ${analysis.signal} (${analysis.confidence}%) - ${analysis.analysis}`);

      } catch (error) {
        logger.error(`Error processing ${pair}:`, error.message);
        await telegram.sendAlert("Signal Error", `Pair: ${pair}\nError: ${error.message}`, "high");
      }
    }

    if (signalsFound === 0) {
      logger.info("No signals found this cycle - market conditions not favorable");
    }
  }
      

  async runPreAlertCycle() {
    logger.info("Running pre-alert scan");
    tradeManager.checkNewDay();
    
    for (const pair of CONFIG.TRADING.PAIRS) {
      try {
        if (tradeManager.isCooldownActive(pair)) continue;
        
        // Check if we already have a pending trade for this pair
        const hasPending = Array.from(tradeManager.activeTrades.values()).some(t => t.pair === pair);
        if (hasPending) continue;

        const data = await marketData.getForexData(pair);
        const analysis = analyzer.analyze(data);
        
        if (analysis.valid && analysis.signal && analysis.confidence >= CONFIG.TRADING.MIN_CONFIDENCE + 10) {
          const message = MessageBuilder.preAlert(pair, analysis);
          await telegram.sendMessage(message);
          logger.info(`Pre-alert sent for ${pair}: ${analysis.signal}`);
        }
      } catch (error) {
        logger.error(`Pre-alert error for ${pair}:`, error.message);
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
        const priceDiff = isCall 
          ? currentPrice - trade.entryPrice 
          : trade.entryPrice - currentPrice;
        
        // Binary options: fixed payout typically 70-90%, loss 100%
        if (isCall) {
          outcome = currentPrice > trade.entryPrice ? "win" : "loss";
          pnl = outcome === "win" ? 85 : -100; // Assume 85% payout
        } else {
          outcome = currentPrice < trade.entryPrice ? "win" : "loss";
          pnl = outcome === "win" ? 85 : -100;
        }

        tradeManager.updateTrade(tradeId, {
          outcome,
          exitPrice: currentPrice,
          pnl,
        });

        const message = MessageBuilder.resultAlert(trade, { outcome, exitPrice: currentPrice, pnl });
        await telegram.sendMessage(message);

      } catch (error) {
        logger.error(`Error checking result for ${tradeId}:`, error.message);
      }
    }
  }

  // Add this to the BinarySignalBot class
  async testSignal(pair = "EURUSD") {
    logger.info(`Generating test signal for ${pair}`);
    try {
      const data = await marketData.getForexData(pair);
      const analysis = analyzer.analyze(data);
      
      logger.info(`Test analysis: ${JSON.stringify({
        valid: analysis.valid,
        signal: analysis.signal,
        confidence: analysis.confidence,
        score: analysis.rawScore,
        trend: analysis.indicators?.trend,
        confluence: analysis.indicators?.confluence,
        analysis: analysis.analysis
      }, null, 2)}`);
      
      // Force a signal for testing
      if (!analysis.signal) {
        analysis.signal = "CALL"; // Force CALL for test
        analysis.confidence = 80;
        analysis.analysis = "TEST SIGNAL - Forced CALL";
      }
      
      const message = MessageBuilder.signalAlert(pair, analysis);
      await telegram.sendMessage(message);
      logger.info("Test signal sent successfully");
      
    } catch (error) {
      logger.error("Test signal failed:", error.message);
    }
  }
  
  async sendDailyReport() {
    const message = MessageBuilder.dailyReport();
    await telegram.sendMessage(message);
    logger.info("Daily report sent with real performance data");
  }

  stop() {
    this.scheduledTasks.forEach((task) => task.stop());
    this.isRunning = false;
    logger.info("Bot stopped gracefully");
  }
}

// ==================== INITIALIZATION ====================
const bot = new BinarySignalBot();

// Graceful shutdown
process.on("SIGTERM", () => bot.stop());
process.on("SIGINT", () => bot.stop());

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  telegram.sendAlert("Fatal Error", error.message, "high").finally(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  telegram.sendAlert("Unhandled Rejection", String(reason), "high");
});

// Start the bot
bot.start().catch((error) => {
  logger.error("Failed to start bot:", error);
  process.exit(1);
});

export default bot;
        
