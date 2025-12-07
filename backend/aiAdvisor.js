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
  '6E': 'IndiGo',
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
 * Learning-based advice using lightweight seasonal_stats table.
 *
 * For each (origin, destination, month), we only store:
 *  - far_sum / far_count: prices when far from departure (>= 30 days)
 *  - near_sum / near_count: prices when close to departure (<= 7 days)
 *
 * We compare average near vs far to see if prices usually go up or down
 * as departure gets closer *in this season*.
 */
async function learningAdvice({ origin, destination, departureDate }) {
  try {
    const month = new Date(departureDate).getMonth() + 1; // 1–12

    const rows = await all(
      `
        SELECT total_points, far_sum, far_count, near_sum, near_count
        FROM seasonal_stats
        WHERE origin = $1 AND destination = $2 AND month = $3
      `,
      [origin, destination, month]
    );

    if (!rows || rows.length === 0) {
      return {
        hasHistory: false,
        points: 0,
        action: 'NO_SIGNAL',
        confidence: 40,
        trend: 'FLAT',
        reason:
          'No seasonal data yet for this route and month. As more recent searches occur, the model will learn.',
      };
    }

    const stat = rows[0];
    const { total_points, far_sum, far_count, near_sum, near_count } = stat;

    // Need at least a few observations in both far and near windows
    if (total_points < 6 || far_count < 2 || near_count < 2) {
      return {
        hasHistory: true,
        points: total_points,
        action: 'NO_SIGNAL',
        confidence: 45,
        trend: 'FLAT',
        reason:
          'Some seasonal data exists, but not enough far vs near observations to detect a robust trend.',
      };
    }

    const farAvg = far_sum / far_count;
    const nearAvg = near_sum / near_count;

    if (!Number.isFinite(farAvg) || !Number.isFinite(nearAvg) || farAvg <= 0) {
      return {
        hasHistory: true,
        points: total_points,
        action: 'NO_SIGNAL',
        confidence: 45,
        trend: 'FLAT',
        reason:
          'Seasonal data is not stable enough to estimate a clear price trend.',
      };
    }

    const delta = nearAvg - farAvg;
    const relChange = delta / farAvg; // positive = prices go up near departure

    let action = 'NO_SIGNAL';
    let confidence = 55;
    let trend = 'FLAT';
    let reason =
      'Seasonal data for this route and month does not show a strong directional trend yet.';

    const STRONG_THRESHOLD = 0.10; // 10%
    const WEAK_THRESHOLD = 0.05;   // 5%

    if (Math.abs(relChange) < WEAK_THRESHOLD) {
      trend = 'FLAT';
      action = 'NO_SIGNAL';
      confidence = 50;
      reason =
        'Seasonal near vs far prices differ by less than ~5%, so the pattern is effectively flat.';
    } else if (relChange > STRONG_THRESHOLD) {
      trend = 'UP';
      action = 'BOOK';
      confidence = 75;
      reason =
        'In this season, prices for this route are usually higher close to departure than far in advance, suggesting a “Book now” bias.';
    } else if (relChange < -STRONG_THRESHOLD) {
      trend = 'DOWN';
      action = 'WAIT';
      confidence = 75;
      reason =
        'In this season, prices for this route are usually lower close to departure than far in advance, suggesting a “Wait” bias if you can be flexible.';
    } else if (relChange > 0) {
      trend = 'UP';
      action = 'BOOK';
      confidence = 65;
      reason =
        'Seasonal data shows a modest upward drift in prices as departure approaches.';
    } else {
      trend = 'DOWN';
      action = 'WAIT';
      confidence = 65;
      reason =
        'Seasonal data shows a modest downward drift in prices as departure approaches.';
    }

    return {
      hasHistory: true,
      points: total_points,
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
      reason: 'Could not load seasonal data due to a database error.',
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
