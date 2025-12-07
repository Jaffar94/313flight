// backend/aggregator.js
const { searchFlights: searchAmadeusFlights } = require('./amadeusClient');
const { searchSkyscannerFlights } = require('./skyscannerClient');
const { searchSerpFlights } = require('./serpFlightsClient');
const { airlineNameFromCode, formatDuration } = require('./aiAdvisor');

// reuse your existing normalizer for Amadeus offers
const { normalizeAmadeusOffer } = require('./normalizeAmadeus'); // or inline in this file

function dedupeFlights(flights) {
  const seen = new Map();
  flights.forEach((f) => {
    const key = `${f.carrierCode}-${f.flightNumber}-${f.departTime}-${f.arrivalTime}`;
    if (!seen.has(key) || f.price < seen.get(key).price) {
      seen.set(key, f);
    }
  });
  return Array.from(seen.values());
}

async function searchAllProviders(params) {
  const {
    originCode,
    destinationCode,
    departureDate,
    returnDate,
    adults,
    cabin,
    currency,
  } = params;

  let flights = [];

  // 1) Amadeus
  try {
    const amadeusRaw = await searchAmadeusFlights({
      originCode,
      destinationCode,
      departureDate,
      returnDate,
      adults,
      cabin,
      currency,
    });

    const offers = amadeusRaw.data || [];
    const amadeusFlights = offers
      .map((offer) =>
        // use your existing normalizeFlightOffer logic
        require('./server').normalizeFlightOffer
          ? require('./server').normalizeFlightOffer(offer, originCode, destinationCode, currency)
          : null
      )
      .filter(Boolean);

    flights = flights.concat(amadeusFlights);
  } catch (e) {
    console.warn('Amadeus search failed:', e.message);
  }

  if (flights.length > 0) {
    return dedupeFlights(flights);
  }

  // 2) Skyscanner fallback
  try {
    const skyFlights = await searchSkyscannerFlights({
      originCode,
      destinationCode,
      departureDate,
      returnDate,
      adults,
      cabin,
      currency,
    });
    flights = flights.concat(skyFlights);
  } catch (e) {
    console.warn('Skyscanner search failed:', e.message);
  }

  if (flights.length > 0) {
    return dedupeFlights(flights);
  }

  // 3) SerpApi (Google Flights) last resort
  try {
    const serpFlights = await searchSerpFlights({
      originCode,
      destinationCode,
      departureDate,
      returnDate,
      adults,
      cabin,
      currency,
    });
    flights = flights.concat(serpFlights);
  } catch (e) {
    console.warn('SerpApi search failed:', e.message);
  }

  return dedupeFlights(flights);
}

module.exports = { searchAllProviders };
