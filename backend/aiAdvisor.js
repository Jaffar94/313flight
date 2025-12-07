// backend/aiAdvisor.js
// Heuristic + Seasonal AI logic (lightweight DB usage)

// Only import db helpers — db does NOT import us → NO circular deps
const { all, run } = require('./db');

/* Airline code → full name */
const AIRLINE_MAP = {
  EK: "Emirates",
  EY: "Etihad Airways",
  QR: "Qatar Airways",
  GF: "Gulf Air",
  UL: "SriLankan Airlines",
  KU: "Kuwait Airways",
  FZ: "FlyDubai",
  '6E': "IndiGo",
  AI: "Air India",
  IX: "Air India Express",
  G9: "Air Arabia",
  WY: "Oman Air",
  SV: "Saudia",
  W5: "Mahan Air",
};

/** Airline full name helper */
function airlineNameFromCode(code) {
  return AIRLINE_MAP[code] || code || "Unknown Airline";
}

/** Convert PT8H30M → "8h 30m" */
function formatDuration(iso) {
  if (!iso) return "";
  const h = iso.match(/(\d+)H/);
  const m = iso.match(/(\d+)M/);
  const hours = h ? h[1] + "h" : "";
  const mins = m ? " " + m[1] + "m" : "";
  return (hours + mins).trim();
}

/* -------------------------------------
   HEURISTIC ADVICE
-------------------------------------- */
function heuristicAdvice({ daysUntilDeparture, minPrice, avgPrice, maxPrice }) {
  const spread = maxPrice - minPrice;

  // Close to departure
  if (daysUntilDeparture <= 7) {
    return {
      action: "BOOK",
      confidence: 80,
      reason: "Close to departure; prices tend to rise and current fares look acceptable.",
    };
  }

  // Very far away
  if (daysUntilDeparture > 30 && avgPrice > (minPrice * 1.2)) {
    return {
      action: "WAIT",
      confidence: 70,
      reason: "Far from travel date and prices are above historical lows.",
    };
  }

  // Middle window
  if (spread < avgPrice * 0.05) {
    return {
      action: "BOOK",
      confidence: 65,
      reason: "Price range is tight; unlikely to fall much lower.",
    };
  }

  return {
    action: "WAIT",
    confidence: 55,
    reason: "Moderate price variability; waiting may yield better prices.",
  };
}

/* -------------------------------------
   UPDATE SEASONAL STATS
-------------------------------------- */
async function updateSeasonalStats({
  origin,
  destination,
  departureDate,
  daysUntilDeparture,
  avgPrice,
}) {
  try {
    const month = new Date(departureDate).getMonth() + 1;

    const isFar = daysUntilDeparture >= 30;
    const isNear = daysUntilDeparture <= 7;

    if (!isFar && !isNear) return; // ignore mid-range

    const price = avgPrice;

    await run(`
      INSERT INTO seasonal_stats (origin, destination, month,
                                  total_points,
                                  far_sum, far_count,
                                  near_sum, near_count,
                                  last_updated)
      VALUES ($1, $2, $3,
              1,
              $4, $5,
              $6, $7,
              NOW())
      ON CONFLICT (origin, destination, month)
      DO UPDATE SET
        total_points = seasonal_stats.total_points + 1,
        far_sum  = seasonal_stats.far_sum  + EXCLUDED.far_sum,
        far_count = seasonal_stats.far_count + EXCLUDED.far_count,
        near_sum = seasonal_stats.near_sum + EXCLUDED.near_sum,
        near_count = seasonal_stats.near_count + EXCLUDED.near_count,
        last_updated = NOW();
    `,
      [
        origin,
        destination,
        month,
        isFar ? price : 0,
        isFar ? 1 : 0,
        isNear ? price : 0,
        isNear ? 1 : 0,
      ]
    );

  } catch (err) {
    console.error("Seasonal stats update failed:", err.message);
  }
}

/* -------------------------------------
   LEARNING ADVICE (SEASONAL)
-------------------------------------- */
async function learningAdvice({ origin, destination, departureDate }) {
  try {
    const month = new Date(departureDate).getMonth() + 1;

    const row = await all(
      `
        SELECT *
        FROM seasonal_stats
        WHERE origin = $1
          AND destination = $2
          AND month = $3
          AND last_updated >= NOW() - INTERVAL '180 days'
      `,
      [origin, destination, month]
    );

    if (!row.length) {
      return { action: "NO_SIGNAL", reason: "No recent seasonal data", confidence: 0 };
    }

    const stats = row[0];

    if (stats.far_count < 2 || stats.near_count < 2) {
      return { action: "NO_SIGNAL", reason: "Not enough trend data", confidence: 0 };
    }

    const farAvg = stats.far_sum / stats.far_count;
    const nearAvg = stats.near_sum / stats.near_count;

    const change = (nearAvg - farAvg) / farAvg;

    if (Math.abs(change) < 0.05) {
      return { action: "NO_SIGNAL", reason: "Seasonal trend too weak", confidence: 40 };
    }

    if (change > 0.08) {
      return {
        action: "BOOK",
        confidence: 75,
        reason: "Historical seasonal trend: prices rise closer to departure.",
      };
    }

    return {
      action: "WAIT",
      confidence: 70,
      reason: "Historical seasonal trend: prices tend to drop as the date approaches.",
    };

  } catch (e) {
    console.error("learningAdvice failed:", e.message);
    return { action: "NO_SIGNAL", reason: "AI error", confidence: 0 };
  }
}

/* -------------------------------------
   BLENDED ADVICE
-------------------------------------- */
async function blendedAdvice({
  origin,
  destination,
  departureDate,
  todayStr,
  minPrice,
  avgPrice,
  maxPrice,
  bestFlight,
}) {
  const daysUntilDeparture = Math.round(
    (new Date(departureDate) - new Date(todayStr)) / (1000 * 60 * 60 * 24)
  );

  const heuristic = heuristicAdvice({
    daysUntilDeparture,
    minPrice,
    avgPrice,
    maxPrice,
  });

  const seasonal = await learningAdvice({ origin, destination, departureDate });

  // If both agree
  if (seasonal.action !== "NO_SIGNAL" && seasonal.action === heuristic.action) {
    return {
      action: heuristic.action,
      confidence: Math.min(100, heuristic.confidence + 10),
      explanation: "Heuristic and seasonal trends both agree.",
      heuristic,
      learning: seasonal,
      bestDeal: bestFlight,
    };
  }

  // If seasonal has signal and heuristic does not
  if (
    seasonal.action !== "NO_SIGNAL" &&
    heuristic.action === "NO_SIGNAL"
  ) {
    return {
      action: seasonal.action,
      confidence: seasonal.confidence,
      explanation: "Seasonal trend detected; heuristic uncertain.",
      heuristic,
      learning: seasonal,
      bestDeal: bestFlight,
    };
  }

  // If heuristic has signal but seasonal does not
  if (
    heuristic.action !== "NO_SIGNAL" &&
    seasonal.action === "NO_SIGNAL"
  ) {
    return {
      action: heuristic.action,
      confidence: heuristic.confidence,
      explanation: "Heuristic confident; seasonal trend not clear.",
      heuristic,
      learning: seasonal,
      bestDeal: bestFlight,
    };
  }

  // If both weak
  return {
    action: "NO_SIGNAL",
    confidence: 40,
    explanation: "No strong signals available.",
    heuristic,
    learning: seasonal,
    bestDeal: bestFlight,
  };
}

module.exports = {
  airlineNameFromCode,
  formatDuration,
  blendedAdvice,
  updateSeasonalStats,
};
