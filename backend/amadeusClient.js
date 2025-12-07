// backend/amadeusClient.js

require('dotenv').config();
const axios = require('axios');

const AMA_ID = process.env.AMADEUS_CLIENT_ID;
const AMA_SECRET = process.env.AMADEUS_CLIENT_SECRET;

let token = null;
let tokenExpires = 0;

async function auth() {
  if (token && Date.now() < tokenExpires) return token;

  const res = await axios.post(
    "https://test.api.amadeus.com/v1/security/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AMA_ID,
      client_secret: AMA_SECRET,
    })
  );

  token = res.data.access_token;
  tokenExpires = Date.now() + res.data.expires_in * 900;

  return token;
}

/** Autocomplete: city / airport search */
async function searchLocations(query) {
  const t = await auth();
  const url =
    "https://test.api.amadeus.com/v1/reference-data/locations?subType=CITY,AIRPORT&keyword=" +
    encodeURIComponent(query);

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${t}` },
  });

  const data = res.data?.data || [];
  return data.map((d) => ({
    iataCode: d.iataCode,
    cityName: d.address?.cityName || d.name,
    countryName: d.address?.countryName,
    type: d.subType,
  }));
}

/** Flight search */
async function searchFlights({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  cabin,
  currency,
}) {
  const t = await auth();

  const params = {
    originLocationCode: originCode,
    destinationLocationCode: destinationCode,
    departureDate,
    adults,
    travelClass: cabin,
    currencyCode: currency,
    max: 50,
  };

  if (returnDate) params.returnDate = returnDate;

  const url = "https://test.api.amadeus.com/v2/shopping/flight-offers";

  const res = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${t}` },
  });

  return res.data;
}

module.exports = {
  searchLocations,
  searchFlights,
};
