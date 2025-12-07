// backend/serpFlightsClient.js

require('dotenv').config();
const axios = require('axios');
const { airlineNameFromCode } = require('./aiAdvisor');

const SERPAPI_KEY = process.env.SERPAPI_KEY;

/**
 * Search Google Flights via SerpApi
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
    console.warn("SERPAPI_KEY missing — skipping SerpApi search");
    return [];
  }

  try {
    const params = {
      engine: "google_flights",
      departure_id: originCode,
      arrival_id: destinationCode,
      outbound_date: departureDate,
      api_key: SERPAPI_KEY,
      currency,
      adults,
      travel_class: cabin,
      type: returnDate ? 1 : 2,
    };

    if (returnDate) params.return_date = returnDate;

    const url = "https://serpapi.com/search";
    const res = await axios.get(url, { params });

    const data = res.data || {};

    const best = data.best_flights || [];
    const other = data.other_flights || [];

    const googleUrl =
      data.search_metadata?.google_flights_url ||
      null;

    const flights = [...best, ...other].map((f) => {
      const seg = f.flights?.[0];
      if (!seg) return null;

      const carrier = seg.airline_code;
      const airline = airlineNameFromCode(carrier);

      return {
        airline,
        flightNumber: seg.flight_number ? `${carrier} ${seg.flight_number}` : `${carrier}`,
        departTime: seg.departure_airport?.time_utc || null,
        arrivalTime: seg.arrival_airport?.time_utc || null,
        nonstop: f.stops === 0,
        stops: f.stops,
        price: f.price || f.price_value || 0,
        currency,
        carrierCode: carrier,
        bookingUrl: googleUrl,
      };
    });

    return flights.filter(Boolean);
  } catch (err) {
    console.error("SerpApi error:", err.response?.data || err.message);
    return [];
  }
}

module.exports = { searchSerpFlights };
