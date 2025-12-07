// backend/aiAdvisor.js
// AI helper: airline name mapping, duration formatting, and "Book or Wait" advisor

const { all } = require('./db');

/**
 * Map airline IATA codes to human-readable names.
 * Extend this map as needed.
 */
const AIRLINE_NAMES = {
  EK: 'Emirates',
  QR: 'Qatar Airways',
  EY: 'Etihad Airways',
  GF: 'Gulf Air',
  UL: 'SriLankan Airlines',
  KU: 'Kuwait Airways',
  AI: 'Air India',
  6E: 'IndiGo',
  G8: 'Go First',
  SG: 'SpiceJet',
  FZ: 'FlyDubai',
  WY: 'Oman Air',
  SV: 'Saudia',
  IX: 'Air India Express',
  LH: 'Lufthansa',
  BA: 'British Airways',
  AF: 'Air France',
  KL: 'KLM',
  TK: 'Turkish Airlines',
  SQ: 'Singapore Airlines',
  CX: 'Cathay Pacific',
  QF: 'Qantas',
  ET: 'Ethiopian Airlines',
  W6: 'Wizz Air',
  U2: 'easyJet',
  FR: 'Ryanair',
  // fallback: show code if unknown
};

/**
 * Convert an airline code to a readable airline name.
 */
function airlineNameFromCode(code) {
  if (!code) return 'Unknown airline';
  const upper = String(code).toUpperCase();
  return AIRLINE_NAMES[upper] || upper;
}

/**
 * Format an ISO-8601 duration string like "PT8H30M" to "8h 30m".
 */
function formatDuration(iso) {
  if (!iso || typeof iso !== 'string') return '';
  // Simple parser for patterns like "PT8H30M" or "PT2H" or "PT45M"
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return iso;

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const mins = match[2] ? parseInt(match[2], 10) : 0;

  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  if (mins) return `${mins}m`;
  return '';
}

/**
 * Heuristic-only advice based on days until departure and price distribution.
 */
function heuristicAdvice({ daysUntilDeparture, minPrice, avgPrice, maxPrice }) {
  let action = 'NO_SIGNAL';
  let confidence = 50;
  let reason = 'Not enough information to give a strong recommendation yet.';

  const spread = maxPrice - minPrice;
  const isLowRelative = avgPrice <= minPrice * 1.1; // avg close to min

  if (daysUntilDeparture <= 7) {
    // Very close to departure: usually book now
    action = 'BOOK';
    confidence = isLowRelative ? 85 : 75;
    reason =
      'You are within 7 days of departure. Prices typically don’t drop much this close to the date.';
  } else if (daysUntilDeparture > 30) {
    // Far away: can consider waiting if prices seem high
    if (avgPrice > minPrice * 1.3) {
      action = 'WAIT';
      confidence = 70;
      reason =
        'Your trip is more than 30 days away and current prices are relatively high versus the cheapest options.';
    } else {
      action = 'BOOK';
      confidence = 60;
      reason =
        'Your trip is more than 30 days away and current prices are not far from the cheapest seen in this search.';
    }
  } else {
    // Medium window: look at spread
    if (spread < avgPrice * 0.1) {
      action = 'BOOK';
      confidence = 65;
      reason =
        'Prices across options are quite clustered, suggesting limited room for big savings later.';
    } else {
      action = 'WAIT';
      confidence = 55;
      reason =
        'There is a decent spread between cheapest and most expensive options; waiting may reveal better fares.';
    }
  }

  return { action, confidence, reason };
}

/**
 * Learning-based advice using historical price data from Postgres.
 * Looks at price trend as departure approaches.
 */
async function learningAdvice({ origin, destination, departureDate }) {
  try {
    // Retrieve history from price_history table (Postgres).
    // IMPORTANT: Postgres-style placeholders ($1, $2, $3) – not "?".
    const rows = await all(
      `
        SELECT days_until_departure, avg_price
        FROM price_history
        WHERE origin = $1 AND destination = $2 AND departure_date = $3
        ORDER BY days_until_departure ASC
      `,
      [origin, destination, departureDate]
    );

    if (!rows || rows.length < 3) {
      return {
        hasHistory: false,
        points: rows ? rows.length : 0,
        action: 'NO_SIGNAL',
        confidence: 40,
        trend: 'FLAT',
        reason:
          'Not enough historical data yet for this route and date. As more searches occur, the model will learn.',
      };
    }

    const points = rows.length;
    const first = rows[0]; // furthest from departure (largest days_until_departure)
    const last = rows[rows.length - 1]; // closest to departure (smallest days_until_departure)

    const delta = last.avg_price - first.avg_price;
    let action = 'NO_SIGNAL';
    let confidence = 55;
    let trend = 'FLAT';
    let reason = 'Historical prices do not show a strong directional trend yet.';

    if (Math.abs(delta) < first.avg_price * 0.05) {
      // <5% change = flat
      trend = 'FLAT';
      action = 'NO_SIGNAL';
      confidence = 55;
      reason = 'Historical prices are fairly flat as departure approaches.';
    } else if (delta > 0) {
      // prices increased as departure approached
      trend = 'UP';
      action = 'BOOK';
      confidence = 70;
      reason =
        'Historically, prices have increased as departure gets closer, which supports booking sooner rather than later.';
    } else {
      // delta < 0 → prices dropped as departure approached
      trend = 'DOWN';
      action = 'WAIT';
      confidence = 70;
      reason =
        'Historically, prices have decreased as departure gets closer, which supports waiting if your dates are flexible.';
    }

    return {
      hasHistory: true,
      points,
      action,
      confidence,
      trend,
      reason,
    };
  } catch (err) {
    console.error('Learning advice DB error:', err.message);
    return {
      hasHistory: false,
      points: 0,
      action: 'NO_SIGNAL',
      confidence: 40,
      trend: 'FLAT',
      reason: 'Could not load historical data due to a database error.',
    };
  }
}

/**
 * Blend heuristic + learning-based advice into a single recommendation.
 *
 * Input:
 *  - origin, destination
 *  - departureDate (YYYY-MM-DD)
 *  - todayStr (YYYY-MM-DD)
 *  - minPrice, avgPrice, maxPrice
 *  - bestFlight (normalized flight object)
 */
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
  try {
    const dep = new Date(departureDate);
    const today = new Date(todayStr);
    const daysUntilDeparture = Math.round(
      (dep - today) / (1000 * 60 * 60 * 24)
    );

    // 1️⃣ Heuristic layer
    const heuristic = heuristicAdvice({
      daysUntilDeparture,
      minPrice,
      avgPrice,
      maxPrice,
    });

    // 2️⃣ Learning layer (Postgres history)
    const learning = await learningAdvice({
      origin,
      destination,
      departureDate,
    });

    // 3️⃣ Blend decisions
    let finalAction = 'NO_SIGNAL';
    let finalLabel = 'No strong signal';
    let finalConfidence = 50;
    let explanationParts = [];

    // If both layers agree on BOOK
    if (heuristic.action === 'BOOK' && learning.action === 'BOOK') {
      finalAction = 'BOOK';
      finalLabel = 'Book now';
      finalConfidence = Math.min(
        95,
        Math.round((heuristic.confidence + learning.confidence) / 2 + 10)
      );
      explanationParts.push(
        'Both the heuristic model and historical trend suggest booking now.'
      );
    }
    // If both layers agree on WAIT
    else if (heuristic.action === 'WAIT' && learning.action === 'WAIT') {
      finalAction = 'WAIT';
      finalLabel = 'Wait';
      finalConfidence = Math.min(
        90,
        Math.round((heuristic.confidence + learning.confidence) / 2 + 5)
      );
      explanationParts.push(
        'Both the heuristic model and historical trend suggest waiting if your plans are flexible.'
      );
    }
    // Disagreement or weak history
    else {
      finalAction = heuristic.action !== 'NO_SIGNAL'
        ? heuristic.action
        : learning.action;

      if (finalAction === 'BOOK') {
        finalLabel = 'Book now';
      } else if (finalAction === 'WAIT') {
        finalLabel = 'Wait';
      } else {
        finalLabel = 'No strong signal';
      }

      // Soften confidence if they disagree
      if (heuristic.action !== learning.action && learning.hasHistory) {
        finalConfidence = Math.round(
          (heuristic.confidence + learning.confidence) / 2 - 10
        );
        explanationParts.push(
          'Heuristic and historical signals do not fully agree, so this recommendation is cautious.'
        );
      } else {
        finalConfidence = Math.round(
          (heuristic.confidence + learning.confidence) / 2
        );
      }
    }

    // Add individual reasons
    explanationParts.push(`Heuristic view: ${heuristic.reason}`);
    explanationParts.push(`Learning view: ${learning.reason}`);

    const bestDeal =
      bestFlight && typeof bestFlight === 'object'
        ? {
            airline: bestFlight.airline,
            flightNumber: bestFlight.flightNumber,
            price: bestFlight.price,
            currency: bestFlight.currency,
            nonstop: bestFlight.nonstop,
            stops: bestFlight.stops,
          }
        : null;

    return {
      action: finalAction,          // 'BOOK', 'WAIT', or 'NO_SIGNAL'
      label: finalLabel,            // 'Book now', 'Wait', etc.
      confidence: finalConfidence,  // 0–100
      explanation: explanationParts.join(' '),
      heuristic,
      learning,
      bestDeal,
    };
  } catch (err) {
    console.error('Blended advice error:', err.message);

    // Fallback to a minimal safe object so UI doesn't break
    return {
      action: 'NO_SIGNAL',
      label: 'No strong signal',
      confidence: 40,
      explanation:
        'An internal error occurred while computing AI advice. Showing a neutral recommendation.',
      heuristic: null,
      learning: null,
      bestDeal: bestFlight
        ? {
            airline: bestFlight.airline,
            flightNumber: bestFlight.flightNumber,
            price: bestFlight.price,
            currency: bestFlight.currency,
            nonstop: bestFlight.nonstop,
            stops: bestFlight.stops,
          }
        : null,
    };
  }
}

module.exports = {
  airlineNameFromCode,
  formatDuration,
  blendedAdvice,
};
