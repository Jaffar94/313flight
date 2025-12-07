// backend/server.js
require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { run, all } = require("./db");
const { searchLocations, searchFlights } = require("./amadeusClient");
const { searchSerpFlights } = require("./serpFlightsClient");
const { searchLocalAirports } = require("./localAirports");

const {
  airlineNameFromCode,
  formatDuration,
  blendedAdvice,
  updateSeasonalStats,
} = require("./aiAdvisor");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "..", "frontend")));

/* ----------------------------------------------------------
   HEALTH
---------------------------------------------------------- */
app.get("/api/health", async (req, res) => {
  res.json({
    status: "ok",
    service: "313flight",
    db: process.env.DATABASE_URL ? "Postgres (Neon)" : "No DB",
  });
});

/* ----------------------------------------------------------
   LOCATIONS (autocomplete)
---------------------------------------------------------- */
app.get("/api/locations", async (req, res) => {
  const q = req.query.q;

  if (!q || q.length < 2) {
    return res.json({ locations: [] });
  }

  try {
    // Run both in parallel
    const [amadeusLocations, localLocations] = await Promise.all([
      searchLocations(q).catch((e) => {
        console.error(
          "Amadeus location error:",
          e.response?.status,
          e.response?.data || e.message
        );
        return []; // fail soft, don’t kill the whole request
      }),
      Promise.resolve(searchLocalAirports(q)),
    ]);

    // Merge & dedupe by IATA code + city
    const combinedMap = new Map();

    function addList(list) {
      for (const loc of list) {
        const key = `${loc.iataCode || ""}-${(loc.cityName || "").toLowerCase()}`;
        if (!combinedMap.has(key)) {
          combinedMap.set(key, loc);
        }
      }
    }

    addList(amadeusLocations);
    addList(localLocations);

    const locations = Array.from(combinedMap.values());

    res.json({ locations });
  } catch (err) {
    console.error("Location error:", err.message);
    res.json({ locations: [] });
  }
});

/* ----------------------------------------------------------
   Normalize Amadeus Flight
---------------------------------------------------------- */
function normalizeAmadeus(offer, origin, dest, currency) {
  try {
    const itin = offer.itineraries[0];
    const segs = itin.segments;
    const first = segs[0];
    const last = segs[segs.length - 1];

    const carrier = first.carrierCode;
    const airline = airlineNameFromCode(carrier);

    return {
      airline,
      flightNumber: `${carrier} ${first.number}`,
      departTime: first.departure.at,
      arrivalTime: last.arrival.at,
      duration: formatDuration(itin.duration),
      nonstop: segs.length === 1,
      stops: segs.length - 1,
      price: parseFloat(offer.price.grandTotal || offer.price.total || 0),
      currency,
      carrierCode: carrier,
      bookingUrl: `https://www.google.com/search?q=${encodeURIComponent(
        `Flights from ${origin} to ${dest} on ${first.departure.at.substring(0, 10)}`
      )}`,
    };
  } catch (err) {
    console.error("Normalize Amadeus failed:", err.message);
    return null;
  }
}

/* ----------------------------------------------------------
   Merge + dedupe
---------------------------------------------------------- */
function dedupeFlights(flights) {
  const map = new Map();
  for (const f of flights) {
    if (!f) continue; // skip invalid entries

    const key = `${f.carrierCode}-${f.flightNumber}-${f.departTime}-${f.arrivalTime}`;
    if (!map.has(key) || f.price < map.get(key).price) {
      map.set(key, f);
    }
  }
  return Array.from(map.values());
}

/* ----------------------------------------------------------
   Postgres history + seasonal update
---------------------------------------------------------- */
async function saveHistory({
  origin,
  destination,
  departureDate,
  currency,
  flights,
}) {
  try {
    if (!process.env.DATABASE_URL) return;
    if (!flights.length) return;

    const prices = flights.map((f) => f.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    const today = new Date();
    const search_date = today.toISOString().slice(0, 10);

    const diffDays = Math.round(
      (new Date(departureDate) - today) / (1000 * 60 * 60 * 24)
    );

    // prune old
    await run(`
      DELETE FROM price_history
      WHERE search_date < CURRENT_DATE - INTERVAL '90 days'
    `);

    // insert
    await run(
      `
      INSERT INTO price_history
        (origin, destination, departure_date, search_date,
         days_until_departure, min_price, avg_price, max_price, currency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
      [
        origin,
        destination,
        departureDate,
        search_date,
        diffDays,
        min,
        avg,
        max,
        currency,
      ]
    );

    // Update seasonal model
    await updateSeasonalStats({
      origin,
      destination,
      departureDate,
      daysUntilDeparture: diffDays,
      avgPrice: avg,
    });

    return { min, avg, max };
  } catch (err) {
    console.error("History saving failed:", err.message);
  }
}

/* ----------------------------------------------------------
   FLEXIBLE DATES: build suggestions from history (±3 days)
---------------------------------------------------------- */
async function getFlexibleDateSuggestions({
  origin,
  destination,
  baseDepartureDate,
  currency,
  baseMinPrice,
}) {
  try {
    if (!process.env.DATABASE_URL) return [];

    const base = new Date(baseDepartureDate);
    if (isNaN(base)) return [];

    const suggestions = [];

    for (let offset = -3; offset <= 3; offset++) {
      const d = new Date(base);
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().slice(0, 10);

      // ✅ Only use rows that match the current currency
      const rows = await all(
        `
        SELECT MIN(min_price) AS min_price
        FROM price_history
        WHERE origin = $1
          AND destination = $2
          AND departure_date = $3
          AND currency = $4
      `,
        [origin, destination, dateStr, currency]
      );

      const row = rows[0];
      if (!row || row.min_price === null) continue;

      const minPrice = Number(row.min_price);

      suggestions.push({
        date: dateStr,
        offset,
        minPrice,
        // ✅ Always report in the current search currency
        currency,
        cheaperThanBase:
          typeof baseMinPrice === "number" && baseMinPrice > 0
            ? minPrice < baseMinPrice
            : false,
      });
    }

    // sort by date offset
    suggestions.sort((a, b) => a.offset - b.offset);
    return suggestions;
  } catch (err) {
    console.error("Flexible dates suggestion failed:", err.message);
    return [];
  }
}


/* ----------------------------------------------------------
   HISTORY ENDPOINT for Trends & History tab
---------------------------------------------------------- */
app.get("/api/history", async (req, res) => {
  try {
    const { origin, destination, departDate } = req.query;

    if (!origin || !destination || !departDate) {
      return res.json({ history: [] });
    }

    if (!process.env.DATABASE_URL) {
      // No DB configured → no history, but respond OK so UI shows friendly message
      return res.json({ history: [] });
    }

    const rows = await all(
      `
      SELECT
        days_until_departure,
        avg_price,
        currency
      FROM price_history
      WHERE origin = $1
        AND destination = $2
        AND departure_date = $3
      ORDER BY days_until_departure ASC
    `,
      [origin, destination, departDate]
    );

    // Frontend expects data.history
    res.json({ history: rows });
  } catch (err) {
    console.error("History load failed:", err.message);
    // Return empty array instead of 500 so UI doesn't show "endpoint missing"
    res.json({ history: [] });
  }
});

/* ----------------------------------------------------------
   FLIGHT SEARCH
---------------------------------------------------------- */
app.post("/api/flights", async (req, res) => {
  try {
    const {
      originCode,
      destinationCode,
      departureDate,
      returnDate,
      tripType,
      travelers,
      cabin,
      currency,
      flexibleDates,
    } = req.body;

    if (!originCode || !destinationCode) {
      return res
        .status(400)
        .json({ error: "Origin and destination required." });
    }

    const adults = Math.min(Math.max(parseInt(travelers, 10) || 1, 1), 9);

    /** Amadeus */
    let amaFlights = [];
    try {
      const ama = await searchFlights({
        originCode,
        destinationCode,
        departureDate,
        returnDate: tripType === "round" ? returnDate : undefined,
        adults,
        cabin,
        currency,
      });

      amaFlights =
        (ama.data || [])
          .map((o) =>
            normalizeAmadeus(o, originCode, destinationCode, currency)
          )
          .filter(Boolean) || [];
    } catch (err) {
      console.warn("Amadeus fail:", err.message);
    }

    /** SerpApi */
    let serpFlights = [];
    try {
      serpFlights = await searchSerpFlights({
        originCode,
        destinationCode,
        departureDate,
        returnDate: tripType === "round" ? returnDate : undefined,
        adults,
        cabin,
        currency,
      });
    } catch (err) {
      console.warn("SerpApi fail:", err.message);
    }

    const flights = dedupeFlights([...amaFlights, ...serpFlights]);

    if (!flights.length) {
      return res.json({
        flights: [],
        model: null,
        flexibleDates: [],
        meta: {
          originCode,
          destinationCode,
          departureDate,
          returnDate,
          currency,
        },
      });
    }

    /** If SerpApi has a Google Flights URL, override bookingUrl */
    const serpUrl = serpFlights[0]?.bookingUrl;
    if (serpUrl) {
      flights.forEach((f) => (f.bookingUrl = serpUrl));
    }

    /** Price stats */
    const prices = flights.map((f) => f.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    const bestFlight = flights.reduce(
      (p, c) => (c.price < p.price ? c : p),
      flights[0]
    );

    // Save history + seasonal stats
    await saveHistory({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      currency,
      flights,
    });

    // Flexible date suggestions (if user toggled it)
    let flexibleSuggestions = [];
    if (flexibleDates) {
      flexibleSuggestions = await getFlexibleDateSuggestions({
        origin: originCode,
        destination: destinationCode,
        baseDepartureDate: departureDate,
        currency,
        baseMinPrice: minPrice,
      });
    }

    // AI blended model
    const model = await blendedAdvice({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      todayStr: new Date().toISOString().slice(0, 10),
      minPrice,
      avgPrice,
      maxPrice,
      bestFlight,
    });

    res.json({
      flights,
      model,
      flexibleDates: flexibleSuggestions,
      meta: {
        originCode,
        destinationCode,
        departureDate,
        returnDate,
        currency,
      },
    });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Unable to load flights" });
  }
});

/* ----------------------------------------------------------
   DEBUG SERP
---------------------------------------------------------- */
app.get("/api/debug-serp", async (req, res) => {
  try {
    const flights = await searchSerpFlights({
      originCode: "DEL",
      destinationCode: "DXB",
      departureDate: "2025-12-01",
      adults: 1,
      cabin: "ECONOMY",
      currency: "INR",
    });

    res.json({ count: flights.length, sample: flights.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------------------------------------
   FALLBACK → serve SPA
---------------------------------------------------------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

app.listen(PORT, () =>
  console.log(`313flight backend running on port ${PORT}`)
);
