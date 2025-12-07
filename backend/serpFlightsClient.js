// backend/serpFlightsClient.js

require("dotenv").config();
const axios = require("axios");
const { airlineNameFromCode } = require("./aiAdvisor");

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Map cabin class → SerpApi travel_class
const CLASS_MAP = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 2,
  BUSINESS: 3,
  FIRST: 4,
};

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
    const travelClass = CLASS_MAP[cabin] || 1;

    const params = {
      engine: "google_flights",
      departure_id: originCode,
      arrival_id: destinationCode,
      outbound_date: departureDate,
      api_key: SERPAPI_KEY,
      currency,
      adults,
      travel_class: travelClass,
      type: returnDate ? 1 : 2, // 1=round, 2=one-way
      deep_search: true,
      gl: "in",
      hl: "en",
    };

    if (returnDate) params.return_date = returnDate;

    const url = "https://serpapi.com/search";
    const res = await axios.get(url, { params });

    const data = res.data || {};
    const best = data.best_flights || [];
    const other = data.other_flights || [];

    const googleUrl = data.search_metadata?.google_flights_url || null;

    const flights = [...best, ...other]
      .map((f) => {
        const seg = f.flights?.[0];
        if (!seg) return null;

        // Extract airline / carrier
        const rawFlightNumber = seg.flight_number || "";
        const carrier = rawFlightNumber.split(" ")[0] || null;

        const airline =
          airlineNameFromCode(carrier) ||
          seg.airline ||
          carrier ||
          "Unknown airline";

        const departTime =
          seg.departure_airport?.time_utc ||
          seg.departure_airport?.time ||
          null;

        const arrivalTime =
          seg.arrival_airport?.time_utc ||
          seg.arrival_airport?.time ||
          null;

        // 🔧 Robust stops handling:
        // 1) use numeric f.stops if present
        // 2) else derive from number of segments
        // 3) else parse string like "1 stop"
        let stopsCount = 0;

        if (typeof f.stops === "number") {
          stopsCount = f.stops;
        } else if (Array.isArray(f.flights) && f.flights.length > 0) {
          // if there are 2 flights segments, that means 1 stop, etc.
          stopsCount = Math.max(0, f.flights.length - 1);
        } else if (typeof f.stops === "string") {
          const m = f.stops.match(/\d+/);
          stopsCount = m ? parseInt(m[0], 10) : 0;
        } else {
          stopsCount = 0;
        }

        const nonstop = stopsCount === 0;

        return {
          airline,
          flightNumber: rawFlightNumber || carrier,
          departTime,
          arrivalTime,
          nonstop,
          stops: stopsCount,
          price: Number(f.price || f.price_value || 0),
          currency,
          carrierCode: carrier,
          bookingUrl: googleUrl,
        };
      })
      .filter((f) => f && f.price > 0);

    return flights;
  } catch (err) {
    console.error("SerpApi error:", err.response?.data || err.message);
    return [];
  }
}

module.exports = { searchSerpFlights };
