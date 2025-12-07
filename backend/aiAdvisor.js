// backend/aiAdvisor.js
const { all } = require('./db');

// Airline code → name map
const AIRLINES = {
  // Middle East & India region
  EK: 'Emirates',
  FZ: 'flydubai',
  EY: 'Etihad Airways',
  GF: 'Gulf Air',
  SV: 'Saudia',
  WY: 'Oman Air',
  QR: 'Qatar Airways',
  G9: 'Air Arabia',
  IX: 'Air India Express',
  AI: 'Air India',
  '6E': 'IndiGo',
  UK: 'Vistara',
  SG: 'SpiceJet',

  // Sri Lanka, Kuwait (the ones you asked)
  UL: 'SriLankan Airlines',
  KU: 'Kuwait Airways',

  // Europe / global majors
  BA: 'British Airways',
  LH: 'Lufthansa',
  AF: 'Air France',
  KL: 'KLM Royal Dutch Airlines',
  TK: 'Turkish Airlines',
  LX: 'SWISS International Air Lines',
  OS: 'Austrian Airlines',

  // Asia-Pacific
  SQ: 'Singapore Airlines',
  CX: 'Cathay Pacific',
  MH: 'Malaysia Airlines',
  GA: 'Garuda Indonesia',
  JL: 'Japan Airlines',
  NH: 'ANA All Nippon Airways',

  // North America
  UA: 'United Airlines',
  AA: 'American Airlines',
  DL: 'Delta Air Lines',
  AC: 'Air Canada',
};



function airlineNameFromCode(code) {
  return AIRLINES[code] || code;
}

function formatDuration(isoDuration) {
  if (!isoDuration) return '';
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?/;
  const match = isoDuration.match(regex);
  if (!match) return isoDuration;
  const hours = match[1] ? `${match[1]}h` : '';
  const mins = match[2] ? `${match[2]}m` : '';
  return `${hours} ${mins}`.trim();
}

function daysBetween(todayStr, departureStr) {
  const today = new Date(todayStr);
  const dep = new Date(departureStr);
  const diff = dep - today;
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

// Heuristic layer
function heuristicAdvice(daysUntilDeparture, minPrice, avgPrice, maxPrice) {
  if (!Number.isFinite(daysUntilDeparture) || !Number.isFinite(minPrice)) {
    return {
      action: 'Unknown',
      confidence: 30,
      reason: 'Not enough data to infer a clear recommendation.',
    };
  }

  let action = 'Unknown';
  let confidence = 50;
  const reasons = [];

  const priceRange = maxPrice - minPrice || 1;
  const relPos = (avgPrice - minPrice) / priceRange; // 0 = cheap, 1 = expensive

  if (daysUntilDeparture <= 7) {
    action = 'Book';
    confidence = 80;
    reasons.push('You are within 7 days of departure.');
  } else if (daysUntilDeparture > 30) {
    if (relPos > 0.7) {
      action = 'Wait';
      confidence = 70;
      reasons.push('Departure is far away and current prices look relatively high.');
    } else {
      action = 'Book';
      confidence = 60;
      reasons.push('Departure is far away and prices are not particularly high.');
    }
  } else {
    if (relPos < 0.4) {
      action = 'Book';
      confidence = 70;
      reasons.push('Current prices are closer to the minimum observed in this search.');
    } else if (relPos > 0.7) {
      action = 'Wait';
      confidence = 60;
      reasons.push('Prices are near the upper end of this search range.');
    }
  }

  if (action === 'Unknown') {
    reasons.push('No strong heuristic signal either way.');
  }

  return {
    action,
    confidence,
    reason: reasons.join(' '),
  };
}

// Simple linear regression
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const denom = (n * sumXX - sumX * sumX) || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Learning layer
async function learningAdvice(origin, destination, departureDate) {
  const rows = await all(
    `
    SELECT days_until_departure, avg_price
    FROM price_history
    WHERE origin = ? AND destination = ? AND departure_date = ?
    ORDER BY days_until_departure ASC
  `,
    [origin, destination, departureDate]
  );

  if (!rows || rows.length < 3) {
    return {
      action: 'Unknown',
      confidence: 40,
      reason: 'Not enough historical data for this route and date.',
      slope: 0,
      pointsUsed: rows.length,
    };
  }

  const points = rows.map((r) => ({ x: r.days_until_departure, y: r.avg_price }));
  const { slope } = linearRegression(points);

  let action = 'Unknown';
  let confidence = 60;
  let reason = '';

  if (slope < 0) {
    action = 'Book';
    confidence = 75;
    reason = 'Historically, prices rise as departure approaches for this route.';
  } else if (slope > 0) {
    action = 'Wait';
    confidence = 70;
    reason = 'Historically, prices drop as departure approaches for this route.';
  } else {
    action = 'Unknown';
    confidence = 45;
    reason = 'Historical prices are fairly flat over time.';
  }

  return {
    action,
    confidence,
    reason,
    slope,
    pointsUsed: rows.length,
  };
}

// Blend both layers
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
  const daysUntil = daysBetween(todayStr, departureDate);

  const heuristic = heuristicAdvice(daysUntil, minPrice, avgPrice, maxPrice);
  const learning = await learningAdvice(origin, destination, departureDate);

  let action = 'No strong signal';
  let confidence = 50;
  const notes = [];

  if (heuristic.action === 'Book' && learning.action === 'Book') {
    action = 'Book now';
    confidence = Math.round((heuristic.confidence + learning.confidence) / 2) + 10;
    notes.push('Heuristic and learning model both suggest booking.');
  } else if (heuristic.action === 'Wait' && learning.action === 'Wait') {
    action = 'Wait';
    confidence = Math.round((heuristic.confidence + learning.confidence) / 2) + 10;
    notes.push('Heuristic and learning model both suggest waiting.');
  } else {
    const hConf = heuristic.confidence || 50;
    const lConf = learning.confidence || 50;
    confidence = Math.round((hConf + lConf) / 2);
    if (heuristic.action === 'Book' && learning.action === 'Wait') {
      action = 'No strong signal';
      notes.push('Short-term heuristic suggests booking, but historical data suggests waiting.');
    } else if (heuristic.action === 'Wait' && learning.action === 'Book') {
      action = 'No strong signal';
      notes.push('Heuristics suggest waiting, but historical data suggests booking.');
    } else if (heuristic.action === 'Book' || learning.action === 'Book') {
      action = 'Book now';
      notes.push('One signal leans toward booking while the other is neutral.');
    } else if (heuristic.action === 'Wait' || learning.action === 'Wait') {
      action = 'Wait';
      notes.push('One signal leans toward waiting while the other is neutral.');
    } else {
      notes.push('Both signals are weak or neutral.');
    }
  }

  if (confidence > 100) confidence = 100;
  if (confidence < 0) confidence = 0;

  const bestLine = bestFlight
    ? `Best found: ${bestFlight.airline} ${bestFlight.flightNumber} at ${bestFlight.price} ${bestFlight.currency} (${bestFlight.nonstop ? 'non-stop' : 'with stops'}).`
    : 'No best deal identified yet.';

  return {
    action,
    confidence,
    explanation: notes.join(' '),
    heuristic,
    learning,
    bestDealSummary: bestLine,
  };
}

module.exports = {
  airlineNameFromCode,
  formatDuration,
  blendedAdvice,
};
