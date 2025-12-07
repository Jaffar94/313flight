// backend/serpFlightsClient.js
const axios = require('axios');
const { airlineNameFromCode } = require('./aiAdvisor');

const SERPAPI_KEY = process.env.SERPAPI_KEY;

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
    throw new Error('SERPAPI_KEY not set');
  }

  // This is also template code; match SerpApi's actual parameter names
  const res = await axios.get('https://serpapi.com/search.json', {
    params: {
      engine: 'google_flights',
      departure_id: originCode,
      arrival_id: destinationCode,
      outbound_date: departureDate,
      return_date: returnDate || undefined,
      currency,
      adults,
      api_key: SERPAPI_KEY,
    },
  });

  const data = res.data;

  // SerpApi structures Google Flights data in JSON; assume:
  const flights = [];

  (data.flights || []).forEach((flight) => {
    const segments = flight.segments || [];
    if (!segments.length) return;
    const first = segments[0];
    const last = segments[segments.length - 1];

    const carrierCode = first.airline?.iata || first.airline_code;
    const flightNumber = `${carrierCode} ${first.flight_number}`;
    const airline = airlineNameFromCode(carrierCode);

    const departTime = first.departure_time_utc || first.departure_time;
    const arrivalTime = last.arrival_time_utc || last.arrival_time;

    const nonstop = segments.length === 1;
    const stops = segments.length - 1;

    // duration may come as minutes or text; handle accordingly
    const duration = flight.duration_text || flight.duration || `${flight.duration_minutes || '?'}m`;

    const priceInfo = flight.price || flight.ticket_price || {};
    const price = parseFloat(priceInfo.amount || priceInfo.value || 0);

    const bookingUrl = flight.booking_url || data.serpapi_link || 'https://www.google.com/flights';

    flights.push({
      airline,
      flightNumber,
      departTime,
      arrivalTime,
      duration,
      nonstop,
      stops,
      price,
      currency: priceInfo.currency || currency,
      bookingUrl,
      carrierCode,
    });
  });

  return flights.filter((f) => f && f.price > 0);
}

module.exports = { searchSerpFlights };
