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
  // Fallback: show the code if unknown
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
      'You are within 7 days of departure. Prices typically do not drop much this close to the date.';
  } else if (daysUntilDeparture > 30) {
    // Far away: can consider waiting if prices seem high
    if (avgPrice > minPrice * 1.3) {
      action = 'WAIT';
      confidence = 70;
      reason =
        'Your trip is more than 30 days away and current prices are relatively high versus the cheapest options in this search.';
    } else {
      action = 'BOOK';
      confidence = 60;
      reason =
        'Your trip is more than 30 days away and current prices are not far from the cheapest options in this search.';
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
        'There is a decent spread between the cheapest and most expensive options; waiting may reveal better fares.';
    }
  }

  return { action, confidence, reason };
}

/**
 * Learning-based advice using SEASONAL historical price data from Postgres.
 *
 * Instead of only looking at this exact departure_date,
 * we look at *all* price_history rows for:
 *   - same origin & destination
 *   - same MONTH of departure_date (season-like)
 *
 * Then we see how average prices behave as days_until_departure decreases.
 */
async function learningAdvice({ origin, destination, departureDate }) {
  try {
    // Use month of departure for a "seasonal" view
    // EXTRACT(MONTH FROM departure_date) = EXTRACT(MONTH FROM $3::date)
    const rows = await all(
      `
        SELECT days_until_departure, avg_price
        FROM price_history
        WHERE origin = $1
          AND destination = $2
          AND EXTRACT(MONTH FROM departure_date) = EXTRACT(MONTH FROM $3::date)
        ORDER BY days_until_departure DESC
      `,
      [origin, destination, departureDate]
    );

    if (!rows || rows.length < 5) {
      // Need a minimum amount of seasonal data
      return {
        hasHistory: false,
        points: rows ? rows.length : 0,
        action: 'NO_SIGNAL',
        confidence: 40,
        trend: 'FLAT',
        reason:
          'Not enough seasonal data yet for this route in this month. As more searches occur, the model will learn.',
      };
    }

    // Aggregate by days_until_departure (because many different departure dates in same month)
    const bucketMap = new Map(); // days_until_departure -> {sum, count}
    for (const r of rows) {
      const d = Number(r.days_until_departure);
      const p = Number(r.avg_price);
      if (!Number.isFinite(d) || !Number.isFinite(p)) continue;
      if (!bucketMap.has(d)) {
        bucketMap.set(d, { sum: 0, count: 0 });
      }
      const b = bucketMap.get(d);
      b.sum += p;
      b.count += 1;
    }

    const buckets = Array.from(bucketMap.entries())
      .map(([d, b]) => ({
        days: d,
        avg: b.sum / b.count,
      }))
      // Larger days_until_departure first = far from departure → close to departure
      .sort((a, b) => b.days - a.days);

    if (buckets.length < 3) {
      return {
        hasHistory: true,
        points: rows.length,
        action: 'NO_SIGNAL',
        confidence: 45,
        trend: 'FLAT',
        reason:
          'Seasonal history exists but not enough distinct days-until-departure points to detect a clear trend.',
      };
    }

    const first = buckets[0]; // far from departure
    const last = buckets[buckets.length - 1]; // close to departure

    const delta = last.avg - first.avg;
    const base = first.avg || last.avg || 1;

    // Relative change
    const relChange = delta / base; // e.g. 0.15 = +15%

    let action = 'NO_SIGNAL';
    let confidence = 55;
    let trend = 'FLAT';
    let reason =
      'Seasonal price data for this route and month does not show a strong directional trend.';

    // Thresholds: require at least 7–10% move to call it a "trend"
    const STRONG_THRESHOLD = 0.10; // 10%
    const WEAK_THRESHOLD = 0.05;   // 5%

    if (Math.abs(relChange) < WEAK_THRESHOLD) {
      // <5% change = effectively flat
      trend = 'FLAT';
      action = 'NO_SIGNAL';
      confidence = 50;
      reason =
        'Seasonal prices are relatively flat as departure approaches, with less than ~5% movement.';
    } else if (relChange > STRONG_THRESHOLD) {
      // Prices rise as departure approaches → better to book
      trend = 'UP';
      action = 'BOOK';
      confidence = 75;
      reason =
        'Seasonal data for this route and month shows prices rising as departure gets closer, suggesting a “Book now” bias.';
    } else if (relChange < -STRONG_THRESHOLD) {
      // Prices fall as departure approaches → better to wait
      trend = 'DOWN';
      action = 'WAIT';
      confidence = 75;
      reason =
        'Seasonal data for this route and month shows prices falling as departure gets closer, suggesting a “Wait” bias if your dates are flexible.';
    } else if (relChange > 0) {
      // Mild upward move
      trend = 'UP';
      action = 'BOOK';
      confidence = 65;
      reason =
        'Seasonal data indicates a modest upward drift in prices as departure approaches, slightly favoring booking earlier.';
    } else {
      // Mild downward move
      trend = 'DOWN';
      action = 'WAIT';
      confidence = 65;
      reason =
        'Seasonal data indicates a modest downward drift in prices as departure approaches, slightly favoring waiting.';
    }

    return {
      hasHistory: true,
      points: rows.length,
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
      reason: 'Could not load seasonal historical data due to a database error.',
    };
  }
}

/**
 * Blend heuristic + seasonal learning-based advice into a single recommendation.
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

    // 1️⃣ Heuristic layer (short-term logic)
    const heuristic = heuristicAdvice({
      daysUntilDeparture,
      minPrice,
      avgPrice,
      maxPrice,
    });

    // 2️⃣ Seasonal learning layer (month-based trends from history)
    const learning = await learningAdvice({
      origin,
      destination,
      departureDate,
    });

    // 3️⃣ Blend decisions conservatively
    let finalAction = 'NO_SIGNAL';
    let finalLabel = 'No strong signal';
    let finalConfidence = 50;
    const explanationParts = [];

    const learningHasStrongOpinion =
      learning.action === 'BOOK' || learning.action === 'WAIT';

    const heuristicHasOpinion =
      heuristic.action === 'BOOK' || heuristic.action === 'WAIT';

    if (heuristicHasOpinion && learningHasStrongOpinion) {
      if (heuristic.action === learning.action) {
        // Both agree
        finalAction = heuristic.action;
        finalLabel = heuristic.action === 'BOOK' ? 'Book now' : 'Wait';
        finalConfidence = Math.min(
          95,
          Math.round((heuristic.confidence + learning.confidence) / 2 + 10)
        );
        explanationParts.push(
          'Both the heuristic model and seasonal price history point in the same direction.'
        );
      } else {
        // Disagreement → cautious
        finalAction = heuristic.action; // lean on short-term + current prices
        finalLabel = heuristic.action === 'BOOK' ? 'Book now' : 'Wait';
        finalConfidence = Math.round(
          (heuristic.confidence + learning.confidence) / 2 - 10
        );
        explanationParts.push(
          'Short-term signals and seasonal history do not fully agree, so this recommendation is cautious.'
        );
      }
    } else if (learningHasStrongOpinion) {
      // Only seasonal history has a clear signal
      finalAction = learning.action;
      finalLabel = learning.action === 'BOOK' ? 'Book now' : 'Wait';
      finalConfidence = learning.confidence;
      explanationParts.push(
        'Recommendation is based mainly on seasonal historical price behavior for this route and month.'
      );
    } else if (heuristicHasOpinion) {
      // Only heuristic has a signal
      finalAction = heuristic.action;
      finalLabel = heuristic.action === 'BOOK' ? 'Book now' : 'Wait';
      finalConfidence = heuristic.confidence;
      explanationParts.push(
        'Recommendation is based mainly on how close you are to departure and the current price distribution.'
      );
    } else {
      // Neither has a strong signal
      finalAction = 'NO_SIGNAL';
      finalLabel = 'No strong signal';
      finalConfidence = 45;
      explanationParts.push(
        'Neither seasonal history nor current price distribution gives a clear direction.'
      );
    }

    // Add detailed views
    explanationParts.push(`Heuristic view: ${heuristic.reason}`);
    explanationParts.push(`Seasonal learning view: ${learning.reason}`);

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

    // Fallback so UI doesn't break
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
      action: 'NO_SIGNAL',
      label: 'No strong signal',
      confidence: 40,
      explanation:
        'An internal error occurred while computing AI advice. Showing a neutral recommendation.',
      heuristic: null,
      learning: null,
      bestDeal,
    };
  }
}

module.exports = {
  airlineNameFromCode,
  formatDuration,
  blendedAdvice,
};
