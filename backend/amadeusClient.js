const axios = require('axios');

let cachedToken = null;
let tokenExpiry = null;

const AMADEUS_BASE = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

async function getAccessToken() {
  const { AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET } = process.env;
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    throw new Error('Amadeus API credentials not set in environment variables.');
  }

  const now = Date.now();
  if (cachedToken && tokenExpiry && now < tokenExpiry) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: AMADEUS_CLIENT_ID,
    client_secret: AMADEUS_CLIENT_SECRET,
  });

  const res = await axios.post(`${AMADEUS_BASE}/v1/security/oauth2/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  cachedToken = res.data.access_token;
  tokenExpiry = now + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function searchLocations(keyword) {
  const token = await getAccessToken();
  const res = await axios.get(`${AMADEUS_BASE}/v1/reference-data/locations`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      keyword,
      subType: 'AIRPORT,CITY',
      'page[limit]': 10,
    },
  });

  return res.data.data.map((item) => ({
    iataCode: item.iataCode,
    name: item.name,
    cityName: item.address?.cityName || item.name,
    countryName: item.address?.countryName || '',
    type: item.subType,
  }));
}

async function searchFlights({
  originCode,
  destinationCode,
  departureDate,
  returnDate,
  adults,
  cabin,
  currency,
}) {
  const token = await getAccessToken();

  const params = {
    originLocationCode: originCode,
    destinationLocationCode: destinationCode,
    departureDate,
    adults,
    currencyCode: currency,
    max: 20,
  };

  if (returnDate) {
    params.returnDate = returnDate;
  }
  if (cabin && cabin !== 'ECONOMY') {
    params.travelClass = cabin;
  }

  const res = await axios.get(`${AMADEUS_BASE}/v2/shopping/flight-offers`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  return res.data;
}

module.exports = {
  searchLocations,
  searchFlights,
};
