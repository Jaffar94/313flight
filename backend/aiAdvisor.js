// backend/aiAdvisor.js
// Heuristic + Seasonal AI logic (lightweight DB usage)

// Only import db helpers — db does NOT import us → NO circular deps
const { all, run } = require("./db");

/* Airline code → full name */
const AIRLINE_MAP = {
  // Gulf / Middle East
  EK: "Emirates",
  EY: "Etihad Airways",
  QR: "Qatar Airways",
  GF: "Gulf Air",
  WY: "Oman Air",
  SV: "Saudia",
  FZ: "flydubai",
  G9: "Air Arabia",
  J9: "Jazeera Airways",
  XY: "flynas",
  F3: "flyadeal",
  RJ: "Royal Jordanian",
  ME: "Middle East Airlines",
  MS: "Egyptair",
  LY: "El Al Israel Airlines",
  IZ: "Arkia Israeli Airlines",
  KU: "Kuwait Airways",

  // India
  "6E": "IndiGo",
  AI: "Air India",
  IX: "Air India Express",
  I5: "AIX Connect",
  UK: "Vistara",
  SG: "SpiceJet",
  QP: "Akasa Air",
  G8: "Go First",

  // Pakistan
  PK: "Pakistan International Airlines",
  ER: "SereneAir",
  PA: "Airblue",

  // Bangladesh
  BG: "Biman Bangladesh Airlines",
  BS: "US-Bangla Airlines",

  // Sri Lanka / Nepal / Maldives / Region
  UL: "SriLankan Airlines",
  "4Y": "Hi Fly", // often operates charters via region

  // Big global carriers (nice to have)
  BA: "British Airways",
  LH: "Lufthansa",
  LX: "SWISS",
  AF: "Air France",
  KL: "KLM",
  TK: "Turkish Airlines",
  SQ: "Singapore Airlines",
  CX: "Cathay Pacific",
  MH: "Malaysia Airlines",
  TG: "Thai Airways",
  JL: "Japan Airlines",
  NH: "ANA",
  UA: "United Airlines",
  AA: "American Airlines",
  DL: "Delta Air Lines",
  QF: "Qantas",
  AC: "Air Canada",
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
   PRICE POSITION (within this search)
-------------------------------------- */
function classifyPricePosition({ minPrice, avgPrice, maxPrice }) {
  if (!minPrice || !avgPrice || !maxPrice) {
    return { label: "UNKNOWN", note: "Not enough price data." };
  }

  const range = maxPrice - minPrice;
  if (range <= 0) {
    return { label: "TYPICAL", note: "All options are priced very similarly." };
  }

  const distFromMin = avgPrice - minPrice;
  const position = distFromMin / range; // 0 = at min, 1 = at max

  if (position <= 0.25) {
    return {
      label: "CHEAP",
      note: "Today’s prices are on the cheaper side of what’s available right now.",
    };
  }

  if (position >= 0.75) {
    return {
      label: "EXPENSIVE",
      note: "Today’s prices are on the expensive side compared to other options for this search.",
    };
  }

  return {
    label: "TYPICAL",
    note: "Prices look fairly typical compared to other options for this search.",
  };
}

/* -------------------------------------
   HEURISTIC ADVICE
-------------------------------------- */
function heuristicAdvice({ daysUntilDeparture, minPrice, avgPrice, maxPrice }) {
  const spread = maxPrice - minPrice;
  const pricePos = classifyPricePosition({ minPrice, avgPrice, maxPrice });

  // Close to departure → usually better to book
  if (daysUntilDeparture <= 7) {
    return {
      action: "BOOK",
      confidence: 80,
      reason:
        "You’re close to departure. For most routes, prices tend to rise in the last week, and current fares look acceptable.",
      pricePosition: pricePos,
    };
  }

  // Very far away and clearly expensive → lean toward waiting
  if (daysUntilDeparture > 30 && pricePos.label === "EXPENSIVE") {
    return {
      action: "WAIT",
      confidence: 70,
      reason:
        "You’re still far from your travel date and today’s prices look expensive compared to other options for this search.",
      pricePosition: pricePos,
    };
  }

  // Narrow spread → not much upside to waiting
  if (spread < avgPrice * 0.05) {
    return {
      action: "BOOK",
      confidence: 65,
      reason:
        "All the available fares are clustered around a similar price, so there may not be much advantage in waiting.",
      pricePosition: pricePos,
    };
  }

  // Default: mild wait suggestion
  return {
    action: "WAIT",
    confidence: 55,
    reason:
      "There is still some price variation for this search, so waiting a bit could reveal a better fare if your dates are flexible.",
    pricePosition: pricePos,
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

    // Only learn from "far" and "near" points; ignore mid-range
    if (!isFar && !isNear) return;

    const price = avgPrice;

    await run(
      `
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
        far_sum      = seasonal_stats.far_sum  + EXCLUDED.far_sum,
        far_count    = seasonal_stats.far_count + EXCLUDED.far_count,
        near_sum     = seasonal_stats.near_sum + EXCLUDED.near_sum,
        near_count   = seasonal_stats.near_count + EXCLUDED.near_count,
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

    const rows = await all(
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

    if (!rows.length) {
      return {
        action: "NO_SIGNAL",
        reason: "We don’t have enough recent seasonal data for this route and month yet.",
        confidence: 0,
      };
    }

    const stats = rows[0];

    if (stats.far_count < 2 || stats.near_count < 2) {
      return {
        action: "NO_SIGNAL",
        reason: "We’ve seen this route, but not often enough to trust a trend yet.",
        confidence: 0,
      };
    }

    const farAvg = stats.far_sum / stats.far_count;
    const nearAvg = stats.near_sum / stats.near_count;
    const change = (nearAvg - farAvg) / farAvg;

    // No strong trend
    if (Math.abs(change) < 0.05) {
      return {
        action: "NO_SIGNAL",
        reason: "Seasonal price changes for this route look small, so there’s no strong pattern.",
        confidence: 40,
      };
    }

    if (change > 0.08) {
      // Prices rise near departure
      return {
        action: "BOOK",
        confidence: 75,
        reason:
          "Historically, prices for this route have risen as departure approaches, especially in this month.",
      };
    }

    // Prices drop near departure
    return {
      action: "WAIT",
      confidence: 70,
      reason:
        "Historically, prices for this route have tended to be lower closer to departure in this month.",
    };
  } catch (e) {
    console.error("learningAdvice failed:", e.message);
    return {
      action: "NO_SIGNAL",
      reason: "We couldn’t load seasonal data, so we’re skipping that signal.",
      confidence: 0,
    };
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

  let action = "NO_SIGNAL";
  let confidence = 40;
  let explanation = "";

  // If both agree and both have a signal
  if (
    seasonal.action !== "NO_SIGNAL" &&
    heuristic.action !== "NO_SIGNAL" &&
    seasonal.action === heuristic.action
  ) {
    action = heuristic.action;
    confidence = Math.min(95, Math.max(heuristic.confidence, seasonal.confidence) + 5);
    explanation =
      action === "BOOK"
        ? "Both today’s prices and recent seasonal trends suggest it’s a good time to book."
        : "Both today’s prices and recent seasonal trends suggest it’s reasonable to wait a bit if your dates are flexible.";
  }
  // If seasonal has signal and heuristic does not
  else if (seasonal.action !== "NO_SIGNAL" && heuristic.action === "NO_SIGNAL") {
    action = seasonal.action;
    confidence = seasonal.confidence || 60;
    explanation =
      action === "BOOK"
        ? "Based on historical price patterns for this route and month, it’s safer to book now."
        : "Based on historical price patterns for this route and month, it may be worth waiting a bit.";
  }
  // If heuristic has signal but seasonal does not
  else if (heuristic.action !== "NO_SIGNAL" && seasonal.action === "NO_SIGNAL") {
    action = heuristic.action;
    confidence = heuristic.confidence || 60;
    explanation =
      action === "BOOK"
        ? "Given how today’s prices compare within this search and how close you are to departure, it makes sense to book."
        : "Given today’s price spread and days until departure, there’s some room to wait if you’re flexible.";
  }
  // If both weak or conflicting
  else {
    action = "NO_SIGNAL";
    confidence = 40;
    explanation =
      "We don’t see a strong pattern from today’s prices or seasonal trends, so there’s no strong AI signal either way.";
  }

  return {
    action,
    confidence,
    explanation,
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
