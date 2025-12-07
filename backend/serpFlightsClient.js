// backend/serpFlightsClient.js

const axios = require('axios');
const { airlineNameFromCode } = require('./aiAdvisor');

const SERPAPI_KEY = process.env.SERPAPI_KEY;

/**
 * This searches Google Flights via SerpApi.
 * NOTE: SerpApi provides LIMITED fields. We normalize the best we can.
 */
async function searchSerpFlights({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  currency,
}) {
  if (!SERPAPI_KEY) {
    throw new Error("Missing SERPAPI_KEY");
  }

  const res = await axios.get("https://serpapi.com/search.json", {
    params: {
      engine: "google_flights",
      departure_id: originCode,
      arrival_id: destinationCode,
      outbound_date: departureDate,
      return_date: returnDate || undefined,
      hl: "en",
      adults,
      currency,
      api_key: SERPAPI_KEY,
    },
  });

  const data = res.data;
  const flights = [];

  if (!data || !data.best_flights) return flights;

  for (const f of data.best_flights) {
    const seg = f.flights?.[0];
    if (!seg) continue;

    const carrierCode = seg.airline_iata || seg.airline;
    const flightNumber = `${carrierCode} ${seg.flight_number}`;

    flights.push({
      airline: airlineNameFromCode(carrierCode),
      flightNumber,
      departTime: seg.departure_airport?.time_utc,
      arrivalTime: seg.arrival_airport?.time_utc,
      duration: f.duration || "",
      nonstop: seg.stops === 0,
      stops: seg.stops || 0,
      price: f.price || 0,
      currency: currency,
      bookingUrl: data.search_metadata?.google_flights_url || 
        "https://www.google.com/flights",
      carrierCode,
    });
  }

  return flights;
}

module.exports = { searchSerpFlights };
