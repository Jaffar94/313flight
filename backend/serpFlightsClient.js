// backend/serpFlightsClient.js

require("dotenv").config();
const axios = require("axios");
const { airlineNameFromCode } = require("./aiAdvisor");

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Map your cabin string -> SerpApi travel_class code
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
      type: returnDate ? 1 : 2, // 1 = round trip, 2 = one-way
      deep_search: true,        // 🔥 get results that match Google Flights UI
      gl: "in",                 // country = India (helps surface local carriers like IndiGo)
      hl: "en",                 // language = English
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

        // SerpApi docs: flights[].airline (name) and flights[].flight_number like "6E 123"
        const rawFlightNumber = seg.flight_number || "";
        const carrierFromFN = rawFlightNumber.split(" ")[0] || null; // e.g. "6E"
        const carrier = carrierFromFN;

        const airline =
          airlineNameFromCode(carrier) || // try backend map
          seg.airline ||                  // fallback to name from SerpApi ("IndiGo")
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

        return {
          airline,
          flightNumber: rawFlightNumber || (carrier || ""),
          departTime,
          arrivalTime,
          nonstop: f.stops === 0,
          stops: f.stops,
          price: Number(f.price || f.price_value || 0),
          currency,
          carrierCode: carrier,
          bookingUrl: googleUrl,
        };
      })
      // keep only usable flights
      .filter((f) => f && f.price > 0);

    return flights;
  } catch (err) {
    console.error("SerpApi error:", err.response?.data || err.message);
    return [];
  }
}

module.exports = { searchSerpFlights };
