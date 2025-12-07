// frontend/app.js

const state = {
  tripType: 'oneway',
  origin: null,
  destination: null,
  flightsRaw: [],
  lastSearchMeta: null,
  historyChart: null,
};

const apiBase = ''; // same origin

// DOM helpers
const $ = (id) => document.getElementById(id);

const form = $('flightForm');
const tripButtons = document.querySelectorAll('.trip-toggle');
const flexibleToggle = $('flexibleToggle');
const originInput = $('originInput');
const originCodeInput = $('originCode');
const originSuggestions = $('originSuggestions');
const destinationInput = $('destinationInput');
const destinationCodeInput = $('destinationCode');
const destinationSuggestions = $('destinationSuggestions');
const departureDateInput = $('departureDate');
const returnDateInput = $('returnDate');
const travelerInput = $('travelerCount');
const cabinSelect = $('cabinSelect');
const currencySelect = $('currencySelect');

const formError = $('formError');
const originError = $('originError');
const destinationError = $('destinationError');
const departError = $('departError');
const returnError = $('returnError');

const loadingState = $('loadingState');
const emptyState = $('emptyState');
const flightsContainer = $('flightsContainer');
const resultsError = $('resultsError');
const globalError = $('globalError');

const sortSelect = $('sortSelect');
const stopsSelect = $('stopsSelect');
const airlineFilter = $('airlineFilter');

const flexStrip = $('flexStrip');
const flexStripInner = $('flexStripInner');

// AI panel elements
const aiBadge = $('aiBadge');
const aiSummary = $('aiSummary');
const aiConfidenceText = $('aiConfidenceText');
const aiConfidenceBar = $('aiConfidenceBar');
const aiHeuristic = $('aiHeuristic');
const aiLearning = $('aiLearning');
const aiBestDeal = $('aiBestDeal');

// Tabs
const tabSearch = $('tab-search');
const tabHistory = $('tab-history');
const tabAbout = $('tab-about');
const panelSearch = $('panel-search');
const panelHistory = $('panel-history');
const panelAbout = $('panel-about');

// History
const historyStatus = $('historyStatus');
const historyCommentary = $('historyCommentary');

function setTripType(type) {
  state.tripType = type;
  tripButtons.forEach((btn) => {
    if (btn.dataset.trip === type) {
      btn.classList.add('bg-sky-500', 'text-slate-900');
      btn.classList.remove('text-slate-300');
    } else {
      btn.classList.remove('bg-sky-500', 'text-slate-900');
      btn.classList.add('text-slate-300');
    }
  });

  if (type === 'round') {
    returnDateInput.disabled = false;
    returnDateInput.classList.remove('bg-slate-900/40', 'text-slate-400');
    returnDateInput.classList.add('bg-slate-900/70', 'text-slate-100');
  } else {
    returnDateInput.disabled = true;
    returnDateInput.value = '';
    returnDateInput.classList.add('bg-slate-900/40', 'text-slate-400');
    returnDateInput.classList.remove('bg-slate-900/70', 'text-slate-100');
  }
}

tripButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    setTripType(btn.dataset.trip);
  });
});

// Simple date min on load
(function initDateMin() {
  const today = new Date().toISOString().slice(0, 10);
  departureDateInput.min = today;
  returnDateInput.min = today;
})();

// Debounce helper
function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// AUTOCOMPLETE
async function fetchLocations(query) {
  if (!query || query.length < 2) return [];
  try {
    const res = await fetch(`${apiBase}/api/locations?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Location error');
    const data = await res.json();
    return data.locations || [];
  } catch (err) {
    console.error('Locations fetch error', err);
    return [];
  }
}

function renderSuggestions(container, list, onSelect) {
  container.innerHTML = '';
  if (!list.length) {
    container.classList.add('hidden');
    return;
  }
  list.forEach((loc) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'w-full text-left px-3 py-2 hover:bg-slate-800/70 border-b border-slate-800 last:border-0';
    btn.textContent = loc.label || `${loc.cityName}, ${loc.countryName} (${loc.iataCode})`;
    btn.addEventListener('click', () => {
      onSelect(loc);
      container.classList.add('hidden');
    });
    container.appendChild(btn);
  });
  container.classList.remove('hidden');
}

// origin
originInput.addEventListener(
  'input',
  debounce(async () => {
    const q = originInput.value.trim();
    if (!q) {
      originSuggestions.classList.add('hidden');
      state.origin = null;
      originCodeInput.value = '';
      return;
    }
    const locs = await fetchLocations(q);
    renderSuggestions(originSuggestions, locs, (loc) => {
      originInput.value =
        loc.label || `${loc.cityName}, ${loc.countryName} (${loc.iataCode})`;
      originCodeInput.value = loc.iataCode;
      state.origin = loc;
    });
  }, 350)
);

// destination
destinationInput.addEventListener(
  'input',
  debounce(async () => {
    const q = destinationInput.value.trim();
    if (!q) {
      destinationSuggestions.classList.add('hidden');
      state.destination = null;
      destinationCodeInput.value = '';
      return;
    }
    const locs = await fetchLocations(q);
    renderSuggestions(destinationSuggestions, locs, (loc) => {
      destinationInput.value =
        loc.label || `${loc.cityName}, ${loc.countryName} (${loc.iataCode})`;
      destinationCodeInput.value = loc.iataCode;
      state.destination = loc;
    });
  }, 350)
);

// Hide suggestions on blur
document.addEventListener('click', (e) => {
  if (!originSuggestions.contains(e.target) && e.target !== originInput) {
    originSuggestions.classList.add('hidden');
  }
  if (!destinationSuggestions.contains(e.target) && e.target !== destinationInput) {
    destinationSuggestions.classList.add('hidden');
  }
});

// FORM VALIDATION
function resetErrors() {
  [formError, originError, destinationError, departError, returnError].forEach((el) => {
    el.classList.add('hidden');
    el.textContent = '';
  });
  resultsError.classList.add('hidden');
  globalError.classList.add('hidden');
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function validateForm() {
  resetErrors();

  const originCode = originCodeInput.value.trim();
  const destinationCode = destinationCodeInput.value.trim();
  const depart = departureDateInput.value;
  const ret = returnDateInput.value;
  const today = new Date().toISOString().slice(0, 10);

  let ok = true;

  if (!originCode) {
    showError(originError, 'Please choose a valid origin from suggestions.');
    ok = false;
  }
  if (!destinationCode) {
    showError(destinationError, 'Please choose a valid destination from suggestions.');
    ok = false;
  }
  if (originCode && destinationCode && originCode === destinationCode) {
    showError(destinationError, 'Origin and destination must be different.');
    ok = false;
  }

  if (!depart) {
    showError(departError, 'Departure date is required.');
    ok = false;
  } else if (depart < today) {
    showError(departError, 'Departure cannot be in the past.');
    ok = false;
  }

  if (state.tripType === 'round') {
    if (!ret) {
      showError(returnError, 'Return date is required for round trips.');
      ok = false;
    } else if (ret <= depart) {
      showError(returnError, 'Return date must be after departure date.');
      ok = false;
    }
  }

  if (!ok) {
    showError(formError, 'Please fix the highlighted fields.');
  }

  return ok;
}

// RENDER FLIGHTS
function formatPrice(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`;
  }
}

function durationToMinutes(d) {
  if (!d) return Infinity;
  let h = 0, m = 0;
  const matchH = d.match(/(\d+)h/);
  const matchM = d.match(/(\d+)m/);
  if (matchH) h = parseInt(matchH[1], 10);
  if (matchM) m = parseInt(matchM[1], 10);
  return h * 60 + m;
}

function renderFlights(list) {
  flightsContainer.innerHTML = '';
  if (!list.length) {
    emptyState.textContent = 'No flights found for this search.';
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  list.forEach((f) => {
    const card = document.createElement('div');
    card.className =
      'rounded-2xl bg-slate-900/70 border border-slate-700/70 px-3 py-3 md:px-4 md:py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between text-xs';

    const left = document.createElement('div');
    left.className = 'flex items-start gap-3';

    const badge = document.createElement('div');
    badge.className =
      'h-8 w-8 rounded-full bg-sky-500/90 flex items-center justify-center text-[0.7rem] font-semibold text-slate-900';
    badge.textContent = (carrier || airlineName || "??")
      .slice(0, 3)
      .toUpperCase();


    const main = document.createElement('div');
    main.className = 'space-y-1';

    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center gap-2 flex-wrap';
    const carrier = f.carrierCode;
    const airlineName =
      f.airline ||
      AIRLINE_MAP[carrier] ||
      carrier ||
      "Unknown airline";

        const carrier = f.carrierCode;
    const airlineName =
      f.airline ||      // backend-pretty name if present
      carrier ||        // at least show the code
      "Unknown airline";

    const airline = document.createElement('span');
    airline.className = 'font-semibold text-slate-100';
    airline.textContent = airlineName;

    const fn = document.createElement('span');
    fn.className = 'px-2 py-0.5 rounded-full bg-slate-800 text-[0.65rem] text-slate-200';
    fn.textContent = f.flightNumber || '';

    titleRow.appendChild(airline);
    titleRow.appendChild(fn);

    // badge:
    badge.textContent = (carrier || airlineName || "??")
      .slice(0, 3)
      .toUpperCase();




    const fn = document.createElement('span');
    fn.className = 'px-2 py-0.5 rounded-full bg-slate-800 text-[0.65rem] text-slate-200';
    fn.textContent = f.flightNumber || '';

    titleRow.appendChild(airline);
    titleRow.appendChild(fn);

    const timeline = document.createElement('div');
    timeline.className = 'flex items-center gap-3 text-[0.7rem] text-slate-300';
    const dep = document.createElement('span');
    dep.textContent = f.departTime ? f.departTime.slice(11, 16) : '–';
    const line = document.createElement('div');
    line.className = 'flex-1 h-px bg-slate-600 relative';
    const plane = document.createElement('span');
    plane.textContent = '✈️';
    plane.className =
      'absolute -top-3 left-1/2 -translate-x-1/2 text-base';
    line.appendChild(plane);
    const arr = document.createElement('span');
    arr.textContent = f.arrivalTime ? f.arrivalTime.slice(11, 16) : '–';

    timeline.appendChild(dep);
    timeline.appendChild(line);
    timeline.appendChild(arr);

    const metaRow = document.createElement('div');
    metaRow.className = 'flex flex-wrap items-center gap-2 text-[0.7rem] text-slate-400';
    const dur = document.createElement('span');
    dur.textContent = f.duration || '';
    const stops = document.createElement('span');
    stops.className =
      'px-2 py-0.5 rounded-full bg-slate-800 text-[0.65rem]';
    stops.textContent = f.nonstop ? 'Non-stop' : `${f.stops} stop${f.stops === 1 ? '' : 's'}`;

    metaRow.appendChild(dur);
    metaRow.appendChild(stops);

    main.appendChild(titleRow);
    main.appendChild(timeline);
    main.appendChild(metaRow);

    left.appendChild(badge);
    left.appendChild(main);

    const right = document.createElement('div');
    right.className =
      'mt-2 md:mt-0 flex flex-col items-end gap-1 text-right';

    const price = document.createElement('div');
    price.className = 'text-sm md:text-base font-semibold text-sky-300';
    price.textContent = formatPrice(f.price, f.currency);

    const bookBtn = document.createElement('a');
    bookBtn.href = f.bookingUrl || '#';
    bookBtn.target = '_blank';
    bookBtn.rel = 'noopener noreferrer';
    bookBtn.className =
      'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-sky-500/90 text-slate-900 text-[0.7rem] font-semibold hover:bg-sky-400';
    bookBtn.textContent = 'Book';
    const arrow = document.createElement('span');
    arrow.textContent = '↗';
    bookBtn.appendChild(arrow);

    right.appendChild(price);
    right.appendChild(bookBtn);

    card.appendChild(left);
    card.appendChild(right);

    flightsContainer.appendChild(card);
  });
}

// FILTERS
function buildAirlineChips() {
  airlineFilter.innerHTML = '';
  const airlines = new Set(state.flightsRaw.map((f) => f.airline).filter(Boolean));
  airlines.forEach((name) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className =
      'airline-chip px-2 py-1 rounded-full border border-slate-600 text-[0.65rem] text-slate-300 hover:bg-slate-800';
    chip.dataset.airline = name;
    chip.textContent = name;
    chip.addEventListener('click', () => {
      chip.classList.toggle('bg-sky-500/80');
      chip.classList.toggle('text-slate-900');
      chip.classList.toggle('border-sky-400');
      applyFiltersAndRender();
    });
    airlineFilter.appendChild(chip);
  });
}

function getActiveAirlines() {
  return Array.from(document.querySelectorAll('.airline-chip.bg-sky-500\\/80'))
    .map((el) => el.dataset.airline);
}

function applyFiltersAndRender() {
  if (!state.flightsRaw.length) return;

  let list = [...state.flightsRaw];

  // stops
  const stops = stopsSelect.value;
  if (stops === 'nonstop') {
    list = list.filter((f) => f.nonstop);
  } else if (stops === 'stops') {
    list = list.filter((f) => !f.nonstop);
  }

  // airline
  const activeAirlines = getActiveAirlines();
  if (activeAirlines.length) {
    list = list.filter((f) => activeAirlines.includes(f.airline));
  }

  // sort
  const sortKey = sortSelect.value;
  if (sortKey === 'price') {
    list.sort((a, b) => a.price - b.price);
  } else if (sortKey === 'depart') {
    list.sort(
      (a, b) =>
        new Date(a.departTime || 0).getTime() - new Date(b.departTime || 0).getTime()
    );
  } else if (sortKey === 'duration') {
    list.sort((a, b) => durationToMinutes(a.duration) - durationToMinutes(b.duration));
  }

  renderFlights(list);
}

sortSelect.addEventListener('change', applyFiltersAndRender);
stopsSelect.addEventListener('change', applyFiltersAndRender);

// AI PANEL
function setBadge(action) {
  const baseClasses =
    'px-2 py-1 rounded-full text-[0.7rem] border';
  if (action === 'BOOK') {
    aiBadge.className = `${baseClasses} bg-emerald-500/20 border-emerald-400 text-emerald-200`;
    aiBadge.textContent = 'Book now';
  } else if (action === 'WAIT') {
    aiBadge.className = `${baseClasses} bg-amber-500/20 border-amber-400 text-amber-200`;
    aiBadge.textContent = 'Wait';
  } else {
    aiBadge.className = `${baseClasses} bg-slate-800 border-slate-600 text-slate-300`;
    aiBadge.textContent = 'No strong signal';
  }
}

function updateAI(model) {
  if (!model) {
    setBadge('NO_SIGNAL');
    aiSummary.textContent = 'No AI recommendation available for this search.';
    aiConfidenceText.textContent = '0%';
    aiConfidenceBar.style.width = '0%';
    aiHeuristic.textContent = '–';
    aiLearning.textContent = '–';
    aiBestDeal.textContent = 'Best deal will appear here after a search.';
    return;
  }

  setBadge(model.action);
  aiSummary.textContent = model.explanation || '';
  aiConfidenceText.textContent = `${model.confidence || 0}%`;
  aiConfidenceBar.style.width = `${Math.min(model.confidence || 0, 100)}%`;

  aiHeuristic.textContent = model.heuristic?.reason || '–';
  aiLearning.textContent = model.learning?.reason || '–';

  if (model.bestDeal) {
    const bd = model.bestDeal;
    aiBestDeal.textContent = `Best found: ${bd.airline || ''} ${bd.flightNumber || ''} at ${formatPrice(
      bd.price,
      bd.currency
    )} (${bd.nonstop ? 'non-stop' : `${bd.stops} stop${bd.stops === 1 ? '' : 's'}`} ).`;
  } else {
    aiBestDeal.textContent = 'Best deal will appear here after a search.';
  }
}

// FLEXIBLE DATES (backend currently returns [], but we support it if added)
function renderFlexibleDates(flexData, baseCurrency) {
  flexStripInner.innerHTML = '';
  if (!flexData || !flexData.length) {
    flexStrip.classList.add('hidden');
    return;
  }

  flexData.forEach((item) => {
    const chip = document.createElement('div');
    chip.className =
      'px-2 py-1 rounded-xl bg-slate-900/70 border border-slate-700 text-[0.65rem]';
    const dateLabel = item.date;
    const offsetStr =
      item.offset > 0 ? `+${item.offset} days` : `${item.offset} days`;
    const priceStr = formatPrice(item.minPrice, item.currency || baseCurrency);

    chip.textContent = `${dateLabel} (${offsetStr}) · ${priceStr}${
      item.cheaperThanBase ? ' 💰' : ''
    }`;
    flexStripInner.appendChild(chip);
  });

  flexStrip.classList.remove('hidden');
}

// HISTORY CHART
function destroyHistoryChart() {
  if (state.historyChart) {
    state.historyChart.destroy();
    state.historyChart = null;
  }
}

async function loadHistory() {
  destroyHistoryChart();
  historyCommentary.textContent = '';
  const meta = state.lastSearchMeta;
  if (!meta || !meta.originCode || !meta.destinationCode || !meta.departureDate) {
    historyStatus.textContent =
      'Run a search first to load price history for that exact route and date.';
    return;
  }
  historyStatus.textContent = 'Loading history...';

  try {
    const params = new URLSearchParams({
      origin: meta.originCode,
      destination: meta.destinationCode,
      departDate: meta.departureDate,
    });
    const res = await fetch(`${apiBase}/api/history?${params.toString()}`);
    if (!res.ok) throw new Error('No history endpoint or error');

    const data = await res.json();
    const history = data.history || [];
    if (!history.length) {
      historyStatus.textContent =
        'No historical data yet for this exact date. As more searches happen, a trend will appear here.';
      return;
    }

    // sort by days_until_departure ascending
    history.sort((a, b) => a.days_until_departure - b.days_until_departure);
    const labels = history.map((h) => h.days_until_departure);
    const prices = history.map((h) => Number(h.avg_price || h.avgPrice));

    const ctx = $('historyChart').getContext('2d');
    state.historyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Average price',
            data: prices,
            tension: 0.2,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Days until departure',
            },
          },
          y: {
            title: {
              display: true,
              text: 'Average price',
            },
          },
        },
      },
    });

    historyStatus.textContent = `History for ${meta.originCode} → ${meta.destinationCode} on ${meta.departureDate}`;

    // Simple commentary: compare first vs last
    const first = prices[0];
    const last = prices[prices.length - 1];
    const change = (last - first) / first;
    if (Math.abs(change) < 0.05) {
      historyCommentary.textContent =
        'Prices for this date have been relatively flat as departure approaches.';
    } else if (change > 0.05) {
      historyCommentary.textContent =
        'For this specific date, prices have generally increased as departure approaches.';
    } else {
      historyCommentary.textContent =
        'For this specific date, prices have generally decreased as departure approaches.';
    }
  } catch (err) {
    console.error('History load error', err);
    historyStatus.textContent =
      'Unable to load price history (endpoint missing or error).';
  }
}

// TABS
function activateTab(tab) {
  if (tab === 'search') {
    panelSearch.classList.remove('hidden');
    panelHistory.classList.add('hidden');
    panelAbout.classList.add('hidden');

    tabSearch.classList.add('bg-slate-800/80', 'text-sky-300');
    tabHistory.classList.remove('bg-slate-800/80', 'text-sky-300');
    tabAbout.classList.remove('bg-slate-800/80', 'text-sky-300');
  } else if (tab === 'history') {
    panelSearch.classList.add('hidden');
    panelHistory.classList.remove('hidden');
    panelAbout.classList.add('hidden');

    tabSearch.classList.remove('bg-slate-800/80', 'text-sky-300');
    tabHistory.classList.add('bg-slate-800/80', 'text-sky-300');
    tabAbout.classList.remove('bg-slate-800/80', 'text-sky-300');

    loadHistory();
  } else if (tab === 'about') {
    panelSearch.classList.add('hidden');
    panelHistory.classList.add('hidden');
    panelAbout.classList.remove('hidden');

    tabSearch.classList.remove('bg-slate-800/80', 'text-sky-300');
    tabHistory.classList.remove('bg-slate-800/80', 'text-sky-300');
    tabAbout.classList.add('bg-slate-800/80', 'text-sky-300');
  }
}

tabSearch.addEventListener('click', () => activateTab('search'));
tabHistory.addEventListener('click', () => activateTab('history'));
if (tabAbout) {
  tabAbout.addEventListener('click', () => activateTab('about'));
}

// FORM SUBMIT
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validateForm()) return;

  const originCode = originCodeInput.value.trim();
  const destinationCode = destinationCodeInput.value.trim();
  const departureDate = departureDateInput.value;
  const returnDate = returnDateInput.value || null;
  const travelers = travelerInput.value || 1;
  const cabin = cabinSelect.value;
  const currency = currencySelect.value;
  const flexibleDates = flexibleToggle.checked;

  loadingState.classList.remove('hidden');
  emptyState.classList.add('hidden');
  flightsContainer.innerHTML = '';
  resultsError.classList.add('hidden');

  try {
    const res = await fetch(`${apiBase}/api/flights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originCode,
        destinationCode,
        originLabel: originInput.value,
        destinationLabel: destinationInput.value,
        departureDate,
        returnDate,
        tripType: state.tripType,
        travelers,
        cabin,
        currency,
        flexibleDates,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Unknown error');
    }

    state.flightsRaw = data.flights || [];
    state.lastSearchMeta =
      data.meta || {
        originCode,
        destinationCode,
        departureDate,
        returnDate,
        currency,
      };

    if (!state.flightsRaw.length) {
      emptyState.textContent = 'No flights found for this search.';
      emptyState.classList.remove('hidden');
      updateAI(null);
      renderFlexibleDates([], currency);
    } else {
      buildAirlineChips();
      applyFiltersAndRender();
      updateAI(data.model || null);
      renderFlexibleDates(data.flexibleDates || [], currency);
    }
  } catch (err) {
    console.error('Search error', err);
    resultsError.textContent =
      'We couldn’t load flights right now. Please try again in a moment.';
    resultsError.classList.remove('hidden');
    updateAI(null);
    renderFlexibleDates([], currencySelect.value);
  } finally {
    loadingState.classList.add('hidden');
  }
});

// Initial UI
activateTab('search');
emptyState.classList.remove('hidden');
