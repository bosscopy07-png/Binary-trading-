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

    if (!closes || closes.length < 200) {
      return { valid: false, reason: "Need at least 200 candles" };
    }

    try {
      const indicators = this.calculateIndicators(closes, highs, lows, volumes);
      
      // First check market conditions
      const marketCondition = this.assessMarketCondition(indicators, closes);
      if (!marketCondition.tradable) {
        return { 
          valid: false, 
          reason: marketCondition.reason,
          marketCondition 
        };
      }

      const signal = this.generateSignal(closes, highs, lows, volumes, indicators, marketCondition);
      
      if (!signal.direction) {
        return { 
          valid: false, 
          reason: signal.reason || "No high-quality setup",
          score: signal.score,
          details: signal.details
        };
      }

      const risk = this.calculateRisk(signal, closes, highs, lows);

      return {
        valid: true,
        signal: signal.direction,
        confidence: signal.confidence,
        entryPrice: closes[closes.length - 1],
        stopLoss: risk.stop,
        takeProfit: risk.target,
        riskReward: risk.rr,
        trend: signal.trend,
        reasoning: signal.reason,
        marketCondition: marketCondition.type,
        score: signal.score,
        confluence: signal.confluence
      };
    } catch (err) {
      return { valid: false, reason: err.message };
    }
  }

  calculateIndicators(closes, highs, lows, volumes) {
    return {
      ema20: EMA.calculate({ period: 20, values: closes }),
      ema50: EMA.calculate({ period: 50, values: closes }),
      ema200: EMA.calculate({ period: 200, values: closes }),
      rsi: RSI.calculate({ period: 14, values: closes }),
      rsi7: RSI.calculate({ period: 7, values: closes }),
      macd: MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),
      atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
      adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
      bb: BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }),
      stochastic: Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3,
      }),
      avgVolume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
    };
  }

  assessMarketCondition(ind, closes) {
    const lastClose = closes.at(-1);
    const atr = ind.atr.at(-1);
    const adx = ind.adx.at(-1)?.adx || 0;
    const bb = ind.bb.at(-1);
    
    const volatility = atr / lastClose;
    const bbWidth = (bb.upper - bb.lower) / lastClose;
    
    // Volatility check
    if (volatility < 0.0015) {
      return { 
        tradable: false, 
        reason: "Too quiet (volatility < 0.15%)",
        type: "low_volatility"
      };
    }
    
    // Extreme volatility check
    if (volatility > 0.008) {
      return {
        tradable: false,
        reason: "Too volatile (chaos)",
        type: "high_volatility"
      };
    }
    
    // Determine market type
    let type = "range";
    if (adx > 25) type = "trending_strong";
    else if (adx > 20) type = "trending_weak";
    
    return {
      tradable: true,
      type,
      adx,
      volatility,
      bbWidth
    };
  }

  generateSignal(closes, highs, lows, volumes, ind, marketCondition) {
    const lastClose = closes.at(-1);
    const lastVolume = volumes.at(-1);
    const prevClose = closes.at(-2) || lastClose;

    const ema20 = ind.ema20.at(-1);
    const ema50 = ind.ema50.at(-1);
    const ema200 = ind.ema200.at(-1);
    const ema20Prev = ind.ema20.at(-2) || ema20;
    const ema50Prev = ind.ema50.at(-2) || ema50;
    
    const rsi = ind.rsi.at(-1);
    const rsiPrev = ind.rsi.at(-2) || rsi;
    const macd = ind.macd.at(-1);
    const macdPrev = ind.macd.at(-2) || macd;
    const bb = ind.bb.at(-1);
    const stoch = ind.stochastic.at(-1);
    const stochPrev = ind.stochastic.at(-2) || stoch;

    let score = 0;
    let confluence = 0;
    let reasons = [];
    let callSignals = 0;
    let putSignals = 0;

    // ========== TREND STRUCTURE ==========
    const trendBull = ema20 > ema50 && ema50 > ema200 && lastClose > ema20;
    const trendBear = ema20 < ema50 && ema50 < ema200 && lastClose < ema20;
    const trendNeutral = !trendBull && !trendBear;

    // EMA Slope
    const ema20Rising = ema20 > ema20Prev;
    const ema50Rising = ema50 > ema50Prev;

    if (trendBull) {
      score += 20;
      callSignals++;
      reasons.push("Bullish structure");
      if (ema20Rising && ema50Rising) {
        score += 10;
        reasons.push("Rising EMAs");
      }
    } else if (trendBear) {
      score -= 20;
      putSignals++;
      reasons.push("Bearish structure");
      if (!ema20Rising && !ema50Rising) {
        score -= 10;
        reasons.push("Falling EMAs");
      }
    }

    // EMA Crossovers
    const goldenCross = ema50Prev <= ema200 && ema50 > ema200;
    const deathCross = ema50Prev >= ema200 && ema50 < ema200;
    const ema20CrossUp = ema20Prev <= ema50 && ema20 > ema50;
    const ema20CrossDown = ema20Prev >= ema50 && ema20 < ema50;

    if (goldenCross) {
      score += 25;
      callSignals++;
      confluence++;
      reasons.push("GOLDEN CROSS");
    } else if (deathCross) {
      score -= 25;
      putSignals++;
      confluence++;
      reasons.push("DEATH CROSS");
    }

    if (ema20CrossUp) {
      score += 15;
      callSignals++;
      confluence++;
      reasons.push("EMA20 crossed above EMA50");
    } else if (ema20CrossDown) {
      score -= 15;
      putSignals++;
      confluence++;
      reasons.push("EMA20 crossed below EMA50");
    }

    // ========== MOMENTUM (RSI) ==========
    const rsiBull = rsi > 50 && rsi < 70 && rsi > rsiPrev;
    const rsiBear = rsi < 50 && rsi > 30 && rsi < rsiPrev;
    const rsiOversold = rsi < 30;
    const rsiOverbought = rsi > 70;
    const rsiDivergenceBull = lastClose < prevClose && rsi > rsiPrev; // Price down, RSI up
    const rsiDivergenceBear = lastClose > prevClose && rsi < rsiPrev; // Price up, RSI down

    if (rsiBull) {
      score += 15;
      callSignals++;
      confluence++;
      reasons.push(`RSI bullish momentum (${rsi.toFixed(1)})`);
    } else if (rsiBear) {
      score -= 15;
      putSignals++;
      confluence++;
      reasons.push(`RSI bearish momentum (${rsi.toFixed(1)})`);
    }

    if (rsiOversold) {
      score += 20;
      callSignals++;
      confluence++;
      reasons.push("RSI OVERSOLD");
    } else if (rsiOverbought) {
      score -= 20;
      putSignals++;
      confluence++;
      reasons.push("RSI OVERBOUGHT");
    }

    if (rsiDivergenceBull) {
      score += 10;
      callSignals++;
      reasons.push("RSI bullish divergence");
    } else if (rsiDivergenceBear) {
      score -= 10;
      putSignals++;
      reasons.push("RSI bearish divergence");
    }

    // ========== MACD ==========
    const macdBull = macd.histogram > 0 && macd.MACD > macd.signal;
    const macdBear = macd.histogram < 0 && macd.MACD < macd.signal;
    const macdCrossUp = macd.histogram > 0 && macdPrev.histogram < 0;
    const macdCrossDown = macd.histogram < 0 && macdPrev.histogram > 0;
    const macdIncreasing = macd.histogram > macdPrev.histogram;

    if (macdCrossUp) {
      score += 20;
      callSignals++;
      confluence++;
      reasons.push("MACD crossed above signal");
    } else if (macdCrossDown) {
      score -= 20;
      putSignals++;
      confluence++;
      reasons.push("MACD crossed below signal");
    } else if (macdBull) {
      score += 12;
      callSignals++;
      confluence++;
      reasons.push("MACD bullish");
      if (macdIncreasing) {
        score += 5;
        reasons.push("MACD increasing");
      }
    } else if (macdBear) {
      score -= 12;
      putSignals++;
      confluence++;
      reasons.push("MACD bearish");
      if (!macdIncreasing) {
        score -= 5;
        reasons.push("MACD decreasing");
      }
    }

    // ========== BOLLINGER BANDS ==========
    const priceBelowBB = lastClose < bb.lower;
    const priceAboveBB = lastClose > bb.upper;
    const priceNearLower = lastClose < bb.lower * 1.005;
    const priceNearUpper = lastClose > bb.upper * 0.995;
    const bbSqueeze = (bb.upper - bb.lower) / lastClose < 0.02;

    if (priceBelowBB) {
      score += 18;
      callSignals++;
      confluence++;
      reasons.push("Price below BB lower");
    } else if (priceAboveBB) {
      score -= 18;
      putSignals++;
      confluence++;
      reasons.push("Price above BB upper");
    }

    if (bbSqueeze) {
      reasons.push("BB Squeeze (breakout potential)");
    }

    // ========== STOCHASTIC ==========
    const stochOversold = stoch.k < 20 && stoch.d < 20;
    const stochOverbought = stoch.k > 80 && stoch.d > 80;
    const stochCrossUp = stoch.k > stoch.d && stochPrev.k <= stochPrev.d;
    const stochCrossDown = stoch.k < stoch.d && stochPrev.k >= stochPrev.d;

    if (stochCrossUp && stochOversold) {
      score += 15;
      callSignals++;
      confluence++;
      reasons.push("Stochastic cross up from oversold");
    } else if (stochCrossDown && stochOverbought) {
      score -= 15;
      putSignals++;
      confluence++;
      reasons.push("Stochastic cross down from overbought");
    } else if (stochOversold) {
      score += 8;
      callSignals++;
      reasons.push("Stochastic oversold");
    } else if (stochOverbought) {
      score -= 8;
      putSignals++;
      reasons.push("Stochastic overbought");
    }

    // ========== VOLUME ==========
    const volumeStrong = lastVolume > ind.avgVolume * 1.3;
    const volumeVeryStrong = lastVolume > ind.avgVolume * 2;

    if (volumeVeryStrong) {
      score = score * 1.15; // Boost score
      reasons.push("Very strong volume");
    } else if (volumeStrong) {
      score = score * 1.08;
      reasons.push("Strong volume");
    }

    // ========== STRATEGY SELECTION ==========
    const isTrending = marketCondition.type.includes("trending");
    let direction = null;
    let confidence = 0;
    let trend = "neutral";

    // TREND FOLLOWING (Strong trend)
    if (isTrending) {
      if (score >= 50 && callSignals >= 3 && trendBull) {
        direction = "CALL";
        trend = "bullish";
        confidence = Math.min(70 + confluence * 3, 90);
      } else if (score <= -50 && putSignals >= 3 && trendBear) {
        direction = "PUT";
        trend = "bearish";
        confidence = Math.min(70 + confluence * 3, 90);
      }
    }
    
    // MEAN REVERSION (Range market or extreme conditions)
    if (!direction && !isTrending) {
      if (score >= 45 && (rsiOversold || priceBelowBB)) {
        direction = "CALL";
        trend = "range";
        confidence = Math.min(65 + confluence * 2, 80);
      } else if (score <= -45 && (rsiOverbought || priceAboveBB)) {
        direction = "PUT";
        trend = "range";
        confidence = Math.min(65 + confluence * 2, 80);
      }
    }

    // MOMENTUM BREAKOUT (BB Squeeze + Volume)
    if (!direction && bbSqueeze && volumeStrong) {
      if (score > 30 && macdBull) {
        direction = "CALL";
        trend = "breakout";
        confidence = 75;
      } else if (score < -30 && macdBear) {
        direction = "PUT";
        trend = "breakout";
        confidence = 75;
      }
    }

    return {
      direction,
      score: Math.abs(score),
      rawScore: score,
      confluence,
      trend,
      confidence,
      reason: reasons.join(" | "),
      details: {
        callSignals,
        putSignals,
        trendBull,
        trendBear,
        rsi,
        macd: macd.histogram,
        bbPosition: (lastClose - bb.lower) / (bb.upper - bb.lower)
      }
    };
  }

  calculateRisk(signal, closes, highs, lows) {
    const atr = ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14,
    }).at(-1);

    const entry = closes.at(-1);
    
    // Dynamic ATR multiplier based on confidence
    let atrMultiplier = 1.5;
    if (signal.confidence > 85) atrMultiplier = 2;
    if (signal.confidence < 70) atrMultiplier = 1.2;

    const stop =
      signal.direction === "CALL"
        ? entry - atr * atrMultiplier
        : entry + atr * atrMultiplier;

    // Risk/Reward 1:2 minimum
    const target =
      signal.direction === "CALL"
        ? entry + atr * atrMultiplier * 2
        : entry - atr * atrMultiplier * 2;

    const rr = (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(2);

    return { stop: stop.toFixed(5), target: target.toFixed(5), rr };
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
        
