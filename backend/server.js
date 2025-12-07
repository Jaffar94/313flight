// backend/server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { run, all, get } = require('./db');
const { searchLocations, searchFlights } = require('./amadeusClient');
const { airlineNameFromCode, formatDuration, blendedAdvice } = require('./aiAdvisor');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: '313flight', db: 'SQLite' });
});

// Locations
app.get('/api/locations', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ locations: [] });

    const data = await searchLocations(q);
    const locations = data.map((loc) => ({
      iataCode: loc.iataCode,
      label: `${loc.cityName}, ${loc.countryName} (${loc.iataCode})`,
      cityName: loc.cityName,
      countryName: loc.countryName,
      type: loc.type,
    }));

    res.json({ locations });
  } catch (err) {
    console.error('Location error:', err.message);
    res.status(500).json({ error: 'Unable to fetch locations at the moment.' });
  }
});

function buildGoogleFlightsUrl(originCode, destinationCode, departTimeIso) {
  // departTimeIso example: "2025-12-01T10:00:00"
  const departDate = (departTimeIso || '').substring(0, 10); // YYYY-MM-DD
  const base = 'https://www.google.com/travel/flights';
  // Hash format: #search;f=ORIGIN;t=DEST;d=YYYY-MM-DD;
  return `${base}#search;f=${encodeURIComponent(originCode)};t=${encodeURIComponent(
    destinationCode
  )};d=${departDate};`;
}

// Normalize Amadeus flight offer
function normalizeFlightOffer(offer, originCode, destinationCode, currency) {
  try {
    const itinerary = offer.itineraries[0];
    const segments = itinerary.segments;
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];

    const carrierCode = firstSeg.carrierCode;
    const flightNumber = `${carrierCode} ${firstSeg.number}`;
    const airline = airlineNameFromCode(carrierCode);

    const departTime = firstSeg.departure.at;
    const arrivalTime = lastSeg.arrival.at;
    const nonstop = segments.length === 1;
    const stops = segments.length - 1;
    const duration = formatDuration(itinerary.duration);
    const price = parseFloat(offer.price.grandTotal || offer.price.total || 0);

    // ✅ New, stronger deep link: origin + destination + correct departure date
    const bookingUrl = buildGoogleFlightsUrl(originCode, destinationCode, departTime);

    return {
      airline,
      flightNumber,
      departTime,
      arrivalTime,
      duration,
      nonstop,
      stops,
      price,
      currency,
      bookingUrl,
      carrierCode,
    };
  } catch (err) {
    console.error('Error normalizing flight offer', err.message);
    return null;
  }
}


// Record history
async function recordPriceHistory({
  origin,
  destination,
  departureDate,
  currency,
  flights,
}) {
  if (!flights || !flights.length) return;

  const prices = flights.map((f) => f.price).filter((p) => Number.isFinite(p));
  if (!prices.length) return;

  const min_price = Math.min(...prices);
  const max_price = Math.max(...prices);
  const avg_price = prices.reduce((a, b) => a + b, 0) / prices.length;

  const today = new Date();
  const search_date = today.toISOString().substring(0, 10);
  const depDate = new Date(departureDate);
  const diffDays = Math.round((depDate - today) / (1000 * 60 * 60 * 24));

  const created_at = new Date().toISOString();

  await run(
    `
      INSERT INTO price_history
      (origin, destination, departure_date, search_date, days_until_departure, min_price, avg_price, max_price, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      origin,
      destination,
      departureDate,
      search_date,
      diffDays,
      min_price,
      avg_price,
      max_price,
      currency,
      created_at,
    ]
  );

  return { min_price, avg_price, max_price, days_until_departure: diffDays };
}

// Flexible dates helper
async function getFlexibleDateSummary({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  cabin,
  currency,
  baseCheapest,
}) {
  const offsets = [-3, -2, -1, 1, 2, 3];
  const baseDate = new Date(departureDate);
  const flexResults = [];

  for (const offset of offsets) {
    try {
      const flexDate = new Date(baseDate);
      flexDate.setDate(baseDate.getDate() + offset);
      const flexDateStr = flexDate.toISOString().substring(0, 10);

      const apiRes = await searchFlights({
        originCode,
        destinationCode,
        departureDate: flexDateStr,
        returnDate,
        adults,
        cabin,
        currency,
      });

      const offers = apiRes.data || [];
      if (!offers.length) continue;

      const normalized = offers
        .map((offer) => normalizeFlightOffer(offer, originCode, destinationCode, currency))
        .filter(Boolean);

      if (!normalized.length) continue;
      const minPrice = Math.min(...normalized.map((f) => f.price));
      flexResults.push({
        date: flexDateStr,
        offset,
        minPrice,
        currency,
        cheaperThanBase: baseCheapest && minPrice < baseCheapest,
      });
    } catch (err) {
      console.warn('Flexible date search failed for offset', offset, err.message);
    }
  }

  return flexResults.sort((a, b) => a.offset - b.offset);
}

// /api/flights
app.post('/api/flights', async (req, res) => {
  try {
    const {
      originCode,
      destinationCode,
      originLabel,
      destinationLabel,
      departureDate,
      returnDate,
      tripType,
      travelers,
      cabin,
      currency,
      flexibleDates,
    } = req.body;

    if (!originCode || !destinationCode) {
      return res.status(400).json({ error: 'Origin and destination are required.' });
    }

    if (originCode === destinationCode) {
      return res.status(400).json({ error: 'Origin and destination must be different.' });
    }

    if (!departureDate) {
      return res.status(400).json({ error: 'Departure date is required.' });
    }

    const today = new Date();
    const dep = new Date(departureDate);
    if (dep < new Date(today.toISOString().substring(0, 10))) {
      return res.status(400).json({ error: 'Departure date cannot be in the past.' });
    }

    if (tripType === 'round' && returnDate) {
      const ret = new Date(returnDate);
      if (ret <= dep) {
        return res
          .status(400)
          .json({ error: 'Return date must be after departure date for round trips.' });
      }
    }

    const adults = Math.min(Math.max(parseInt(travelers, 10) || 1, 1), 9);

    const apiRes = await searchFlights({
      originCode,
      destinationCode,
      departureDate,
      returnDate: tripType === 'round' ? returnDate : undefined,
      adults,
      cabin,
      currency,
    });

    const offers = apiRes.data || [];
    const flights = offers
      .map((offer) => normalizeFlightOffer(offer, originCode, destinationCode, currency))
      .filter(Boolean);

    if (!flights.length) {
      return res.json({
        flights: [],
        model: null,
        flexibleDates: [],
      });
    }

    const prices = flights.map((f) => f.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const bestFlight = flights.reduce((best, f) => (f.price < best.price ? f : best), flights[0]);

    await recordPriceHistory({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      currency,
      flights,
    });

    const todayStr = today.toISOString().substring(0, 10);
    const model = await blendedAdvice({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      todayStr,
      minPrice,
      avgPrice,
      maxPrice,
      bestFlight,
    });

    let flexSummary = [];
    if (flexibleDates) {
      flexSummary = await getFlexibleDateSummary({
        originCode,
        destinationCode,
        departureDate,
        returnDate: tripType === 'round' ? returnDate : undefined,
        adults,
        cabin,
        currency,
        baseCheapest: minPrice,
      });
    }

    res.json({
      flights,
      model,
      flexibleDates: flexSummary,
      meta: {
        originCode,
        destinationCode,
        originLabel,
        destinationLabel,
        departureDate,
        returnDate: tripType === 'round' ? returnDate : null,
        currency,
        cabin,
        travelers: adults,
      },
    });
  } catch (err) {
    console.error('Flight search error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Unable to load flights right now. Please try again in a moment.',
    });
  }
});

// /api/history
app.get('/api/history', async (req, res) => {
  try {
    const { origin, destination, departDate } = req.query;
    if (!origin || !destination || !departDate) {
      return res.status(400).json({
        error: 'origin, destination and departDate query parameters are required.',
      });
    }

    const rows = await all(
      `
        SELECT days_until_departure, avg_price, min_price, max_price, search_date
        FROM price_history
        WHERE origin = ? AND destination = ? AND departure_date = ?
        ORDER BY days_until_departure ASC
      `,
      [origin, destination, departDate]
    );

    res.json({ history: rows });
  } catch (err) {
    console.error('/api/history error', err.message);
    res.status(500).json({
      error: 'Unable to load price history.',
    });
  }
});

// /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalRow = await get('SELECT COUNT(*) as count FROM price_history', []);
    const topRoutes = await all(
      `
      SELECT origin, destination, COUNT(*) as count
      FROM price_history
      GROUP BY origin, destination
      ORDER BY count DESC
      LIMIT 5
    `
    );

    res.json({
      dbEngine: 'SQLite',
      totalHistoryPoints: totalRow?.count || 0,
      topRoutes,
    });
  } catch (err) {
    console.error('/api/stats error', err.message);
    res.status(500).json({
      error: 'Unable to load stats.',
    });
  }
});

// Fallback: serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`313flight backend listening on port ${PORT}`);
});
