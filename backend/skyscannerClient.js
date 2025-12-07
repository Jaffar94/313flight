// backend/skyscannerClient.js
const axios = require('axios');
const { airlineNameFromCode, formatDuration } = require('./aiAdvisor');

const SKYSCANNER_API_KEY = process.env.SKYSCANNER_API_KEY;
// Base URL & exact endpoints depend on Skyscanner product you use
const SKYSCANNER_BASE = process.env.SKYSCANNER_BASE_URL || 'https://partners.api.skyscanner.net';

async function searchSkyscannerFlights({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  cabin,
  currency,
}) {
  if (!SKYSCANNER_API_KEY) {
    throw new Error('SKYSCANNER_API_KEY not set');
  }

  // This is pseudo-code; adapt to actual endpoint & schema:
  const res = await axios.get(`${SKYSCANNER_BASE}/flights/search`, {
    params: {
      origin: originCode,
      destination: destinationCode,
      departureDate,
      returnDate: returnDate || undefined,
      adults,
      cabinClass: cabin?.toLowerCase() || 'economy',
      currency: currency || 'USD',
      apiKey: SKYSCANNER_API_KEY,
    },
  });

  const data = res.data;

  // The exact structure depends on Skyscanner's response.
  // Pretend we have data.itineraries[] and each has pricing & legs:
  const flights = (data.itineraries || []).map((it) => {
    const leg = it.legs[0];
    const firstSegment = leg.segments[0];
    const lastSegment = leg.segments[leg.segments.length - 1];

    const carrierCode = firstSegment.marketingCarrier.code;
    const flightNumber = `${carrierCode} ${firstSegment.flightNumber}`;
    const airline = airlineNameFromCode(carrierCode);

    const departTime = firstSegment.departure;
    const arrivalTime = lastSegment.arrival;
    const nonstop = leg.segments.length === 1;
    const stops = leg.segments.length - 1;
    const duration = formatDuration(leg.duration || null); // adapt if they give minutes

    const price = parseFloat(it.price?.amount || 0);
    const bookingUrl = it.bookingUrl || data.deepLink || 'https://www.skyscanner.com';

    return {
      airline,
      flightNumber,
      departTime,
      arrivalTime,
      duration,
      nonstop,
      stops,
      price,
      currency: it.price?.currency || currency,
      bookingUrl,
      carrierCode,
    };
  });

  return flights.filter((f) => f && f.price > 0);
}

module.exports = { searchSkyscannerFlights };
