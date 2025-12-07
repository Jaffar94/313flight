// backend/server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { run, all } = require('./db');
const { searchLocations, searchFlights } = require('./amadeusClient');
const { searchSerpFlights, searchSerpLocations } = require('./serpFlightsClient');
const { airlineNameFromCode, formatDuration, blendedAdvice } = require('./aiAdvisor');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: '313flight', db: 'Postgres (Neon)' });
});

// Locations (autocomplete) – Amadeus primary, SerpApi fallback/booster
app.get('/api/locations', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ locations: [] });

    // 1️⃣ Primary: Amadeus location search
    let locations = [];
    try {
      const data = await searchLocations(q);
      locations = (data || []).map((loc) => ({
        iataCode: loc.iataCode,
        label: `${loc.cityName}, ${loc.countryName} (${loc.iataCode})`,
        cityName: loc.cityName,
        countryName: loc.countryName,
        type: loc.type,
      }));
    } catch (err) {
      console.warn('Amadeus location search failed:', err.message);
    }

    // 2️⃣ Fallback/booster: SerpApi airports if Amadeus misses things
    let serpLocations = [];
    try {
      serpLocations = await searchSerpLocations(q);
    } catch (err) {
      console.warn('SerpApi location search failed:', err.message);
    }

    // 3️⃣ Merge + dedupe by IATA code (Amadeus first, then SerpApi)
    const map = new Map();

    for (const loc of locations) {
      if (!loc.iataCode) continue;
      map.set(loc.iataCode.toUpperCase(), loc);
    }

    for (const loc of serpLocations) {
      if (!loc.iataCode) continue;
      const code = loc.iataCode.toUpperCase();
      if (!map.has(code)) {
        map.set(code, loc);
      }
    }

    const merged = Array.from(map.values());

    res.json({ locations: merged });
  } catch (err) {
    console.error('Location error:', err.message);
    res.status(500).json({ error: 'Unable to fetch locations at the moment.' });
  }
});


/**
 * Build a Google Flights URL using a search query:
 *  - origin airport
 *  - destination airport
 *  - departure date (YYYY-MM-DD)
 *
 * Uses a Google search query so Flights usually opens with correct route + date.
 */
function buildGoogleFlightsUrl(originCode, destinationCode, departTimeIso) {
  const departDate = (departTimeIso || '').substring(0, 10); // YYYY-MM-DD
  const query = `Flights from ${originCode} to ${destinationCode} on ${departDate}`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Normalize Amadeus flight offer into frontend shape
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

    // Fallback Google search link with route + date encoded
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

// Merge + dedupe flights from different providers
function dedupeFlights(flights) {
  const map = new Map();

  flights.forEach((f) => {
    if (!f) return;
    const key = `${f.carrierCode || ''}-${f.flightNumber || ''}-${f.departTime || ''}-${f.arrivalTime || ''}`;
    const existing = map.get(key);
    if (!existing || (Number.isFinite(f.price) && f.price < existing.price)) {
      map.set(key, f);
    }
  });

  return Array.from(map.values());
}

// Record price history snapshot in Postgres (Neon)
// Record price history snapshot in Postgres (Neon) – fail-safe
async function recordPriceHistory({
  origin,
  destination,
  departureDate,
  currency,
  flights,
}) {
  try {
    // If DB is not configured, skip logging
    if (!process.env.DATABASE_URL) {
      console.warn('No DATABASE_URL set; skipping price history logging.');
      return;
    }

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
        (origin, destination, departure_date, search_date, days_until_departure,
         min_price, avg_price, max_price, currency, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
  } catch (err) {
    // Very important: log, but DO NOT throw
    console.error('Error recording price history:', err.message);
    return;
  }
}

// Flexible dates helper (Amadeus only)
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

// /api/flights – main search (Amadeus + SerpApi), AI, flexible dates
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

    // Basic validation
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

    // 1️⃣ Amadeus flights
    let flightsAmadeus = [];
    try {
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
      flightsAmadeus = offers
        .map((offer) => normalizeFlightOffer(offer, originCode, destinationCode, currency))
        .filter(Boolean);
    } catch (err) {
      console.warn('Amadeus search failed:', err.message);
    }

    // 2️⃣ SerpApi flights (Google Flights)
    let flightsSerp = [];
    try {
      flightsSerp = await searchSerpFlights({
        originCode,
        destinationCode,
        departureDate,
        returnDate: tripType === 'round' ? returnDate : undefined,
        adults,
        cabin,
        currency,
      });
    } catch (err) {
      console.warn('SerpApi search failed:', err.message);
    }

    console.log(
      `[Search] ${originCode}->${destinationCode} ${departureDate} | Amadeus=${flightsAmadeus.length}, SerpApi=${flightsSerp.length}`
    );

    // 3️⃣ Merge + dedupe from both sources
    const flights = dedupeFlights([...flightsAmadeus, ...flightsSerp]);

    if (!flights.length) {
      return res.json({
        flights: [],
        model: null,
        flexibleDates: [],
      });
    }

    // If SerpApi provided a specific Google Flights search URL, reuse it for all flights
    const serpSearchUrl =
      flightsSerp.find((f) => f.bookingUrl && f.bookingUrl.includes('google.com'))?.bookingUrl;

    if (serpSearchUrl) {
      flights.forEach((f) => {
        f.bookingUrl = serpSearchUrl;
      });
    }

    // Stats for AI
    const prices = flights.map((f) => f.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const bestFlight = flights.reduce(
      (best, f) => (f.price < best.price ? f : best),
      flights[0]
    );

    // Record history snapshot (combined data) in Postgres
    await recordPriceHistory({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      currency,
      flights,
    });

    // AI blended advice
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

    // Flexible dates: Amadeus-only (to save SerpApi quota)
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

// /api/history – return historical price snapshots
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
        WHERE origin = $1 AND destination = $2 AND departure_date = $3
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

// DEBUG: directly test SerpApi from the backend
app.get('/api/debug-serp', async (req, res) => {
  try {
    const flights = await searchSerpFlights({
      originCode: 'DEL',
      destinationCode: 'DXB',
      departureDate: '2026-02-01',
      returnDate: null,
      adults: 1,
      cabin: 'ECONOMY',
      currency: 'INR',
    });

    res.json({
      count: flights.length,
      sample: flights.slice(0, 3),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback: serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`313flight backend listening on port ${PORT}`);
});
