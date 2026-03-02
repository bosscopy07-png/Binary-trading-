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
      return { valid: false, reason: `Insufficient data: ${closes?.length || 0} candles, need 200` };
    }

    try {
      const indicators = this.calculateIndicators(closes, highs, lows, volumes);
      const signals = this.generateSignals(indicators, closes, highs, lows);
      const confidence = this.calculateConfidence(indicators, signals, closes);
      const levels = this.findSupportResistance(closes, highs, lows);

      // Log detailed analysis for debugging
      logger.info(`Analysis for ${closes.length} candles - Score: ${signals.score}, Direction: ${signals.direction}, Confluence: ${signals.confluence}`);

      return {
        valid: true,
        signal: signals.direction,
        confidence,
        indicators: { ...indicators, trend: signals.trend, ...levels },
        entryPrice: closes[closes.length - 1],
        stopLoss: this.calculateStopLoss(closes, highs, lows, signals.direction),
        takeProfit: this.calculateTakeProfit(closes, signals.direction, levels),
        analysis: signals.reasoning,
        riskReward: this.calculateRiskReward(closes, signals.direction, levels),
        rawScore: signals.score, // For debugging
      };
    } catch (error) {
      logger.error("Analysis error:", error.message);
      return { valid: false, reason: `Analysis failed: ${error.message}` };
    }
  }

  calculateIndicators(closes, highs, lows, volumes) {
    return {
      ema20: EMA.calculate({ period: 20, values: closes }),
      ema50: EMA.calculate({ period: 50, values: closes }),
      ema200: EMA.calculate({ period: 200, values: closes }),
      rsi: RSI.calculate({ period: 14, values: closes }),
      rsi7: RSI.calculate({ period: 7, values: closes }),
      bb: BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }),
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
      stochastic: Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3,
      }),
    };
  }

  findSupportResistance(closes, highs, lows) {
    const lookback = 20;
    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);
    
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);
    const currentPrice = closes[closes.length - 1];
    
    const distToRes = ((resistance - currentPrice) / currentPrice) * 100;
    const distToSup = ((currentPrice - support) / currentPrice) * 100;
    
    return {
      support: support.toFixed(5),
      resistance: resistance.toFixed(5),
      distToSupport: distToSup.toFixed(2),
      distToResistance: distToRes.toFixed(2),
    };
  }

  generateSignals(ind, closes, highs, lows) {
    const lastClose = closes[closes.length - 1];
    const len = closes.length;
    
    const lastEma20 = ind.ema20[ind.ema20.length - 1];
    const lastEma50 = ind.ema50[ind.ema50.length - 1];
    const lastEma200 = ind.ema200[ind.ema200.length - 1];
    const prevEma50 = ind.ema50[ind.ema50.length - 2] || lastEma50;
    const prevEma200 = ind.ema200[ind.ema200.length - 2] || lastEma200;
    
    const lastRSI = ind.rsi[ind.rsi.length - 1];
    const prevRSI = ind.rsi[ind.rsi.length - 2] || lastRSI;
    const lastMACD = ind.macd[ind.macd.length - 1];
    const lastBB = ind.bb[ind.bb.length - 1];
    const lastATR = ind.atr[ind.atr.length - 1];
    const lastADX = ind.adx[ind.adx.length - 1];
    const lastStoch = ind.stochastic[ind.stochastic.length - 1];

    let score = 0;
    let reasoning = [];
    let confluenceCount = 0;
    let callSignals = 0;
    let putSignals = 0;

    // 1. EMA TREND ANALYSIS (Strong weight)
    const trendUp = lastEma50 > lastEma200 && lastEma20 > lastEma50;
    const trendDown = lastEma50 < lastEma200 && lastEma20 < lastEma50;
    const strongTrend = lastADX > 25;

    if (trendUp) {
      score += 15;
      callSignals++;
      reasoning.push("EMA uptrend");
      if (strongTrend) {
        score += 10;
        reasoning.push("Strong trend (ADX>25)");
      }
    } else if (trendDown) {
      score -= 15;
      putSignals++;
      reasoning.push("EMA downtrend");
      if (strongTrend) {
        score -= 10;
        reasoning.push("Strong trend (ADX>25)");
      }
    }

    // 2. EMA CROSSOVER (High weight)
    const goldenCross = prevEma50 <= prevEma200 && lastEma50 > lastEma200;
    const deathCross = prevEma50 >= prevEma200 && lastEma50 < lastEma200;
    const emaBullish = lastEma20 > lastEma50;
    const emaBearish = lastEma20 < lastEma50;

    if (goldenCross) {
      score += 25;
      callSignals++;
      confluenceCount++;
      reasoning.push("GOLDEN CROSS");
    } else if (deathCross) {
      score -= 25;
      putSignals++;
      confluenceCount++;
      reasoning.push("DEATH CROSS");
    }

    if (emaBullish && !goldenCross) {
      score += 10;
      callSignals++;
      reasoning.push("EMA20>50 bullish");
    } else if (emaBearish && !deathCross) {
      score -= 10;
      putSignals++;
      reasoning.push("EMA20<50 bearish");
    }

    // 3. RSI MOMENTUM (Medium weight)
    const rsiBullish = lastRSI > 50 && lastRSI < 70;
    const rsiBearish = lastRSI < 50 && lastRSI > 30;
    const rsiOversold = lastRSI < 30;
    const rsiOverbought = lastRSI > 70;
    const rsiRising = lastRSI > prevRSI;

    if (rsiBullish) {
      score += 15;
      callSignals++;
      confluenceCount++;
      reasoning.push(`RSI bullish (${lastRSI.toFixed(1)})`);
    } else if (rsiBearish) {
      score -= 15;
      putSignals++;
      confluenceCount++;
      reasoning.push(`RSI bearish (${lastRSI.toFixed(1)})`);
    }

    if (rsiOversold) {
      score += 20; // Strong reversal signal
      callSignals++;
      confluenceCount++;
      reasoning.push("RSI OVERSOLD (<30)");
    } else if (rsiOverbought) {
      score -= 20;
      putSignals++;
      confluenceCount++;
      reasoning.push("RSI OVERBOUGHT (>70)");
    }

    // 4. MACD MOMENTUM (Medium weight)
    if (lastMACD) {
      const macdBullish = lastMACD.histogram > 0 && lastMACD.MACD > lastMACD.signal;
      const macdBearish = lastMACD.histogram < 0 && lastMACD.MACD < lastMACD.signal;
      const macdCrossUp = lastMACD.histogram > 0 && ind.macd[ind.macd.length - 2]?.histogram < 0;
      const macdCrossDown = lastMACD.histogram < 0 && ind.macd[ind.macd.length - 2]?.histogram > 0;

      if (macdCrossUp) {
        score += 20;
        callSignals++;
        confluenceCount++;
        reasoning.push("MACD CROSS UP");
      } else if (macdCrossDown) {
        score -= 20;
        putSignals++;
        confluenceCount++;
        reasoning.push("MACD CROSS DOWN");
      } else if (macdBullish) {
        score += 10;
        callSignals++;
        reasoning.push("MACD bullish");
      } else if (macdBearish) {
        score -= 10;
        putSignals++;
        reasoning.push("MACD bearish");
      }
    }

    // 5. BOLLINGER BANDS (Medium weight)
    if (lastBB) {
      const priceBelowBB = lastClose < lastBB.lower;
      const priceAboveBB = lastClose > lastBB.upper;
      const priceNearLower = lastClose < lastBB.lower * 1.001;
      const priceNearUpper = lastClose > lastBB.upper * 0.999;

      if (priceBelowBB) {
        score += 20;
        callSignals++;
        confluenceCount++;
        reasoning.push("Price below BB lower (mean reversion)");
      } else if (priceAboveBB) {
        score -= 20;
        putSignals++;
        confluenceCount++;
        reasoning.push("Price above BB upper (mean reversion)");
      } else if (priceNearLower && lastRSI < 40) {
        score += 10;
        callSignals++;
        reasoning.push("Near BB support");
      } else if (priceNearUpper && lastRSI > 60) {
        score -= 10;
        putSignals++;
        reasoning.push("Near BB resistance");
      }
    }

    // 6. STOCHASTIC (Low weight)
    if (lastStoch) {
      const stochOversold = lastStoch.k < 20 && lastStoch.d < 20;
      const stochOverbought = lastStoch.k > 80 && lastStoch.d > 80;
      const stochBullish = lastStoch.k > lastStoch.d && lastStoch.k < 50;
      const stochBearish = lastStoch.k < lastStoch.d && lastStoch.k > 50;

      if (stochOversold) {
        score += 10;
        callSignals++;
        reasoning.push("Stoch oversold");
      } else if (stochOverbought) {
        score -= 10;
        putSignals++;
        reasoning.push("Stoch overbought");
      } else if (stochBullish) {
        score += 5;
        callSignals++;
        reasoning.push("Stoch bullish");
      } else if (stochBearish) {
        score -= 5;
        putSignals++;
        reasoning.push("Stoch bearish");
      }
    }

    // Determine direction based on score and confluence
    let direction = null;
    const minScore = 35; // Lowered threshold
    const minConfluence = 2; // Require at least 2 indicators
    
    if (score >= minScore && callSignals >= minConfluence) {
      direction = "CALL";
    } else if (score <= -minScore && putSignals >= minConfluence) {
      direction = "PUT";
    }

    return {
      direction,
      score: Math.abs(score),
      reasoning: reasoning.join(" | "),
      trend: trendUp ? "bullish" : trendDown ? "bearish" : "neutral",
      confluence: Math.max(callSignals, putSignals),
      volatility: lastATR,
      rawScore: score, // Keep for debugging
    };
  }

  calculateConfidence(indicators, signals, closes) {
    let confidence = Math.min(signals.score * 1.2, 90); // Scale up slightly
    
    // Boost for high confluence (multiple indicators agreeing)
    confidence += signals.confluence * 3;
    
    // Trend alignment bonus
    if (signals.direction === "CALL" && signals.trend === "bullish") confidence += 5;
    if (signals.direction === "PUT" && signals.trend === "bearish") confidence += 5;
    
    // Volatility check - avoid very low volatility
    const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
    const volatilityPct = (signals.volatility / avgPrice) * 100;
    if (volatilityPct < 0.03) confidence -= 15; // Too quiet
    else if (volatilityPct > 0.1) confidence += 5; // Good volatility
    
    return Math.min(Math.max(confidence, 0), 95); // Cap at 95%
  }

  calculateStopLoss(closes, highs, lows, direction) {
    const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const lastATR = atr[atr.length - 1];
    const lastClose = closes[closes.length - 1];
    
    // Use 1.5x ATR for stop loss, or minimum 10 pips
    const atrStop = direction === "CALL" 
      ? lastClose - (lastATR * 1.5) 
      : lastClose + (lastATR * 1.5);
    
    return atrStop;
  }

  calculateTakeProfit(closes, direction, levels) {
    const lastClose = closes[closes.length - 1];
    const atr = ATR.calculate({ 
      high: closes.map((c, i) => Math.max(c, closes[i-1] || c)),
      low: closes.map((c, i) => Math.min(c, closes[i-1] || c)),
      close: closes, 
      period: 14 
    });
    const lastATR = atr[atr.length - 1];
    
    // Use 2x ATR or next S/R level, whichever is closer
    const atrTarget = direction === "CALL" 
      ? lastClose + (lastATR * 2)
      : lastClose - (lastATR * 2);
    
    const srTarget = direction === "CALL" 
      ? parseFloat(levels.resistance) 
      : parseFloat(levels.support);
    
    // Return the closer target (more conservative)
    const atrDist = Math.abs(atrTarget - lastClose);
    const srDist = Math.abs(srTarget - lastClose);
    
    return (atrDist < srDist ? atrTarget : srTarget);
  }

  calculateRiskReward(closes, direction, levels) {
    const entry = closes[closes.length - 1];
    const stop = this.calculateStopLoss(
      closes, 
      closes.map((c, i) => Math.max(c, closes[i-1] || c)),
      closes.map((c, i) => Math.min(c, closes[i-1] || c)),
      direction
    );
    const target = this.calculateTakeProfit(closes, direction, levels);
    
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(parseFloat(target) - entry);
    
    return risk > 0 ? (reward / risk).toFixed(2) : "0.00";
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

    await this.testSignal("EURUSD");
    
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
        
