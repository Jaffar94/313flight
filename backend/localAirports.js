// backend/localAirports.js
const path = require("path");
const fs = require("fs");

// Load airports data once at startup
const airportsPath = path.join(__dirname, "data", "airports.json");
const airports = JSON.parse(fs.readFileSync(airportsPath, "utf8"));

/**
 * Simple text search on local airports.
 * Matches on city, airport name, country or IATA code.
 */
function searchLocalAirports(query) {
  if (!query) return [];

  const q = query.toLowerCase();

  return airports
    .filter((a) => {
      return (
        (a.iataCode && a.iataCode.toLowerCase().includes(q)) ||
        (a.name && a.name.toLowerCase().includes(q)) ||
        (a.cityName && a.cityName.toLowerCase().includes(q)) ||
        (a.countryName && a.countryName.toLowerCase().includes(q))
      );
    })
    .map((a) => ({
      iataCode: a.iataCode,
      cityName: a.cityName || a.name,
      countryName: a.countryName,
      type: "AIRPORT",
      label: `${a.cityName || a.name}, ${a.countryName} (${a.iataCode})`,
      source: "LOCAL"
    }));
}

module.exports = {
  searchLocalAirports,
};
