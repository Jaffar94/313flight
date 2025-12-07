// backend/amadeusClient.js
const axios = require('axios');

let cachedToken = null;
let tokenExpiry = null;

// Default to Amadeus test API, can be overridden via env
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

// Location autocomplete: AIRPORT + CITY
// Now with graceful fallback for Middle East cities when Amadeus returns nothing
async function searchLocations(keyword) {
  const token = await getAccessToken();

  let apiData = [];
  try {
    const res = await axios.get(`${AMADEUS_BASE}/v1/reference-data/locations`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        keyword,
        subType: 'AIRPORT,CITY',
        'page[limit]': 10,
      },
    });
    apiData = res.data.data || [];
  } catch (err) {
    console.warn('Amadeus location API error:', err.response?.data || err.message);
    apiData = [];
  }

  // If Amadeus returns some results, use them
  if (apiData.length > 0) {
    return apiData.map((item) => ({
      iataCode: item.iataCode,
      name: item.name,
      cityName: item.address?.cityName || item.name,
      countryName: item.address?.countryName || '',
      type: item.subType,
    }));
  }

  // 🔁 FALLBACKS for common Middle East queries when API returns nothing
  const k = (keyword || '').trim().toLowerCase();
  const fallback = [];

  // UAE / Dubai
  if (k.includes('dubai') || k === 'dxb' || k === 'uae') {
    fallback.push({
      iataCode: 'DXB',
      name: 'Dubai International Airport',
      cityName: 'Dubai',
      countryName: 'United Arab Emirates',
      type: 'CITY',
    });
    fallback.push({
      iataCode: 'DWC',
      name: 'Al Maktoum International Airport',
      cityName: 'Dubai',
      countryName: 'United Arab Emirates',
      type: 'AIRPORT',
    });
  }

  // Abu Dhabi
  if (k.includes('abu dhabi') || k === 'auh') {
    fallback.push({
      iataCode: 'AUH',
      name: 'Abu Dhabi International Airport',
      cityName: 'Abu Dhabi',
      countryName: 'United Arab Emirates',
      type: 'CITY',
    });
  }

  // Saudi Arabia / Riyadh
  if (k.includes('riyadh') || k === 'ruh' || k.includes('saudi')) {
    fallback.push({
      iataCode: 'RUH',
      name: 'King Khalid International Airport',
      cityName: 'Riyadh',
      countryName: 'Saudi Arabia',
      type: 'CITY',
    });
  }

  // Jeddah
  if (k.includes('jeddah') || k === 'jed') {
    fallback.push({
      iataCode: 'JED',
      name: 'King Abdulaziz International Airport',
      cityName: 'Jeddah',
      countryName: 'Saudi Arabia',
      type: 'CITY',
    });
  }

  // Qatar / Doha
  if (k.includes('doha') || k === 'doh' || k.includes('qatar')) {
    fallback.push({
      iataCode: 'DOH',
      name: 'Hamad International Airport',
      cityName: 'Doha',
      countryName: 'Qatar',
      type: 'CITY',
    });
  }

  // Oman / Muscat
  if (k.includes('muscat') || k === 'mct' || k.includes('oman')) {
    fallback.push({
      iataCode: 'MCT',
      name: 'Muscat International Airport',
      cityName: 'Muscat',
      countryName: 'Oman',
      type: 'CITY',
    });
  }

  // Kuwait
  if (k.includes('kuwait') || k === 'kwi') {
    fallback.push({
      iataCode: 'KWI',
      name: 'Kuwait International Airport',
      cityName: 'Kuwait City',
      countryName: 'Kuwait',
      type: 'CITY',
    });
  }

  // If still nothing, just return empty
  return fallback;
}

// Flight offers search
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
