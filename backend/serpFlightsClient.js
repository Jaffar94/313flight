// backend/serpFlightsClient.js
const axios = require('axios');
const { airlineNameFromCode } = require('./aiAdvisor');

// Read SERPAPI_KEY once from env
const SERPAPI_KEY = process.env.SERPAPI_KEY;
console.log('SERPAPI_KEY present in env?', !!SERPAPI_KEY);

/**
 * Format minutes into "Xh Ym"
 */
function formatMinutesToDuration(mins) {
  if (!mins || !Number.isFinite(mins)) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * Search Google Flights via SerpApi and normalize into 313flight's flight shape.
 * Uses the Google Flights Results API: best_flights + other_flights.
 */
async function searchSerpFlights({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  cabin,
  currency,
}) {
  if (!SERPAPI_KEY) {
    console.warn('SERPAPI_KEY is not set; SerpApi will not be used.');
    return [];
  }

  // Optional: map cabin class to SerpApi travel_class
  const travelClassMap = {
    ECONOMY: 1,
    PREMIUM_ECONOMY: 2,
    BUSINESS: 3,
    FIRST: 4,
  };
  const travel_class = cabin ? travelClassMap[cabin.toUpperCase()] : undefined;

  const params = {
    api_key: SERPAPI_KEY,
    engine: 'google_flights',
    departure_id: originCode,
    arrival_id: destinationCode,
    outbound_date: departureDate,
    hl: 'en',
    currency: currency || 'USD',
  };

  if (returnDate) params.return_date = returnDate;
  if (adults) params.adults = adults;
  if (travel_class) params.travel_class = travel_class;

  const res = await axios.get('https://serpapi.com/search.json', { params });
  const data = res.data || {};

  const buckets = [];
  if (Array.isArray(data.best_flights)) buckets.push(...data.best_flights);
  if (Array.isArray(data.other_flights)) buckets.push(...data.other_flights);

  const flights = [];

  for (const bucket of buckets) {
    const segs = bucket.flights || [];
    if (!segs.length) continue;

    const first = segs[0];
    const last = segs[segs.length - 1];

    const departTime =
      first.departure_airport?.time || first.departure_airport?.time_utc || null;
    const arrivalTime =
      last.arrival_airport?.time || last.arrival_airport?.time_utc || null;

    const durationMinutes =
      bucket.total_duration ||
      bucket.duration ||
      segs.reduce((sum, s) => sum + (s.duration || 0), 0);

    const duration = formatMinutesToDuration(durationMinutes);

    // flight_number is usually like "6E 123" or "NH 962"
    const rawFlightNumber = first.flight_number || '';
    let carrierCode = '';
    let flightNumber = rawFlightNumber;

    if (rawFlightNumber) {
      const parts = rawFlightNumber.split(' ');
      if (parts.length >= 2) {
        carrierCode = parts[0];
        flightNumber = `${parts[0]} ${parts[1]}`;
      }
    }

    const airline = first.airline || airlineNameFromCode(carrierCode);
    const price = Number(bucket.price || 0);

    flights.push({
      airline,
      flightNumber,
      departTime,
      arrivalTime,
      duration,
      nonstop: segs.length === 1,
      stops: segs.length - 1,
      price,
      currency: currency || 'USD',
      bookingUrl:
        data.search_metadata?.google_flights_url || 'https://www.google.com/flights',
      carrierCode,
    });
  }

  const cleaned = flights.filter(
    (f) => f && f.departTime && f.arrivalTime && Number.isFinite(f.price) && f.price > 0
  );

  console.log(
    `[SerpApi] origin=${originCode}, dest=${destinationCode}, date=${departureDate}, flights=${cleaned.length}`
  );

  return cleaned;
}

module.exports = { searchSerpFlights };
