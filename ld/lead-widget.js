const DASHBOARD_SELECTOR = '[data-lead-dashboard]';
const container = document.querySelector(DASHBOARD_SELECTOR);
const DEFAULT_ENDPOINT = 'https://eml-production-ec0f.up.railway.app';
const endpoint = container?.dataset.generateEndpoint?.replace(/\/generate$/, '') || DEFAULT_ENDPOINT;
const SAMPLE_LEADS = [
  {
    name: 'Revi Design',
    address: 'Wausau, WI',
    phone: '(715) 555-0101',
    google_maps_url: 'https://www.google.com/maps',
    email: 'dave@revi-design.com',
    about: 'Lawn care and landscaping specialists serving the Wausau area, focused on clean designs and reliable service.',
    email_subject: 'Quick idea for Revi Design',
    email_body:
      'Hello,\n\nI am a student at D.C. Everest Senior High in 12th grade that is planning on going to school for business and computer science. I currently run a small business named Evergreen Media Labs, a website creation agency, and I came across your business, Revi Design, on Google and noticed your dedication to creating beautiful yards. If I am mistaken and you do have a website, maybe you are interested in a refreshed or upgraded presence. I have attached some of my work to this email.\n\nThank you,\nOwner of Evergreen Media Labs',
  },
];

const searchInput = document.getElementById('search-input');
const tabButtons = document.querySelectorAll('[data-lead-tab]');
const sendButton = document.getElementById('sendQueueButton');
const sendStatusEl = document.getElementById('sendStatus');
const exportSentButton = document.getElementById('exportSentButton');
const reloadButton = document.getElementById('reloadLeadsButton');

let cachedLeads = [];
let searchTerm = '';
let activeTab = 'dashboard';
let overviewRange = '7d';
let tabsInitialized = false;
let searchInitialized = false;
let sendInitialized = false;
let exportInitialized = false;
let reloadInitialized = false;
let refreshInProgress = false;
let sendStatusPoll = null;
let openStatusRefreshInFlight = false;
let generatorProgressCache = null;
const CHICAGO_TIMEZONE = 'America/Chicago';

const OVERVIEW_RANGES = {
  '24h': { label: '24h', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  '1m': { label: '1m', ms: 30 * 24 * 60 * 60 * 1000 },
  '1y': { label: '1y', ms: 365 * 24 * 60 * 60 * 1000 },
  all: { label: 'All', ms: null },
};

const iconChevron = `<svg viewBox="0 0 10 6" role="presentation" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatCell = (value, placeholder = '—') => escapeHtml(value || placeholder);

const formatSentTimestamp = (value) => {
  const parsed = parseTimestamp(value);
  if (!parsed) {
    return null;
  }
  return parsed.toLocaleString([], { timeZone: CHICAGO_TIMEZONE });
};

const formatChicagoDateTime = (value) => {
  if (!value) {
    return 'N/A';
  }
  return value.toLocaleString([], { timeZone: CHICAGO_TIMEZONE });
};

const formatChicagoTime = (value) =>
  value.toLocaleTimeString([], { timeZone: CHICAGO_TIMEZONE, hour: 'numeric', minute: '2-digit' });

const parseTimestamp = (value) => {
  if (!value) {
    return null;
  }
  const stringValue = String(value).trim();
  const isoWithoutTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(stringValue);
  const parsed = new Date(isoWithoutTimezone ? `${stringValue}Z` : stringValue);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const formatDuration = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) {
    return 'N/A';
  }
  if (n < 60) {
    return `${n.toFixed(1)}s`;
  }
  const mins = Math.floor(n / 60);
  const secs = Math.round(n % 60);
  return `${mins}m ${secs}s`;
};

const formatCompactDuration = (seconds) => {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(n / 60);
  const secs = n % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours === 0) {
    return `${mins}m`;
  }
  return `${hours}h ${remMins}m`;
};

const getRangeStart = () => {
  const config = OVERVIEW_RANGES[overviewRange] || OVERVIEW_RANGES['7d'];
  if (config.ms == null) {
    return null;
  }
  return new Date(Date.now() - config.ms);
};

const inOverviewRange = (dateValue) => {
  const rangeStart = getRangeStart();
  if (!rangeStart) {
    return true;
  }
  const parsed = parseTimestamp(dateValue);
  if (!parsed) {
    return false;
  }
  return parsed >= rangeStart;
};

const getGeneratedTimestamp = (lead) => lead.generated_at || lead.queued_at || lead.sent_at || null;

const getStatusKey = (lead) => String(lead.status || 'Drafted').toLowerCase();

const deriveLeadCity = (lead) => lead.city || (lead.address || '').split(',')[1]?.trim() || '';

const csvEscape = (value) => {
  const stringValue = String(value ?? '');
  return `"${stringValue.replace(/"/g, '""')}"`;
};

const buildSentCsv = (leads) => {
  const rows = [
    [
      'generated on',
      'name of business',
      'city',
      'email',
      'description',
      'email message',
    ],
  ];

  leads.forEach((lead) => {
    const generatedAt = parseTimestamp(getGeneratedTimestamp(lead));
    rows.push([
      generatedAt ? formatChicagoDateTime(generatedAt) : '',
      lead.name || '',
      deriveLeadCity(lead),
      lead.email || '',
      lead.about || '',
      lead.email_body || '',
    ]);
  });

  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
};

const downloadCsv = (filename, csvContent) => {
  const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const buildTrendBuckets = (leads, type) => {
  const rangeStart = getRangeStart();
  const now = new Date();
  let bucketCount = 8;
  let bucketMs = 24 * 60 * 60 * 1000;
  if (overviewRange === '24h') {
    bucketCount = 6;
    bucketMs = 4 * 60 * 60 * 1000;
  } else if (overviewRange === '7d') {
    bucketCount = 7;
    bucketMs = 24 * 60 * 60 * 1000;
  } else if (overviewRange === '1m') {
    bucketCount = 6;
    bucketMs = 5 * 24 * 60 * 60 * 1000;
  } else if (overviewRange === '1y') {
    bucketCount = 12;
    bucketMs = 30 * 24 * 60 * 60 * 1000;
  } else if (overviewRange === 'all') {
    bucketCount = 10;
    const timestamps = leads
      .map((lead) => parseTimestamp(type === 'sent' ? lead.sent_at : getGeneratedTimestamp(lead)))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (timestamps.length > 1) {
      const span = Math.max(now - timestamps[0], 1);
      bucketMs = Math.ceil(span / bucketCount);
    } else {
      bucketMs = 7 * 24 * 60 * 60 * 1000;
    }
  }
  const start = rangeStart || new Date(now.getTime() - bucketCount * bucketMs);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(start.getTime() + index * bucketMs),
    end: new Date(start.getTime() + (index + 1) * bucketMs),
    count: 0,
  }));

  leads.forEach((lead) => {
    const timestamp = parseTimestamp(type === 'sent' ? lead.sent_at : getGeneratedTimestamp(lead));
    if (!timestamp || timestamp < start) {
      return;
    }
    const idx = Math.min(Math.floor((timestamp - start) / bucketMs), bucketCount - 1);
    if (idx >= 0 && buckets[idx]) {
      buckets[idx].count += 1;
    }
  });

  return buckets.map((bucket) => {
    const labelDate = bucket.start;
    let label = `${labelDate.getMonth() + 1}/${labelDate.getDate()}`;
    if (overviewRange === '24h') {
      label = labelDate.toLocaleTimeString([], { timeZone: CHICAGO_TIMEZONE, hour: 'numeric' });
    } else if (overviewRange === '1y') {
      label = labelDate.toLocaleDateString([], { timeZone: CHICAGO_TIMEZONE, month: 'short' });
    }
    return { label, count: bucket.count };
  });
};

const renderTrendCard = (title, series) => {
  const max = Math.max(...series.map((point) => point.count), 1);
  return `
    <section class="overview-card overview-card--trend">
      <div class="overview-card__header">
        <h4>${escapeHtml(title)}</h4>
      </div>
      <div class="overview-trend">
        ${series
          .map(
            (point) => `
          <div class="overview-trend__item">
            <div class="overview-trend__bar-wrap">
              <div class="overview-trend__bar" style="height:${Math.max(6, Math.round((point.count / max) * 100))}%"></div>
            </div>
            <span class="overview-trend__value">${point.count}</span>
            <span class="overview-trend__label">${escapeHtml(point.label)}</span>
          </div>`
          )
          .join('')}
      </div>
    </section>
  `;
};

const calculateOverviewStats = (allLeads) => {
  const leads = Array.isArray(allLeads) ? allLeads : [];
  const sentLeads = leads.filter((lead) => parseTimestamp(lead.sent_at));
  const sentInRange = sentLeads.filter((lead) => inOverviewRange(lead.sent_at));
  const generatedInRange = leads.filter((lead) => inOverviewRange(getGeneratedTimestamp(lead)));
  const queuedNow = leads.filter((lead) => getStatusKey(lead) === 'queued').length;
  const draftsCount = leads.filter((lead) => getStatusKey(lead) === 'drafted').length;
  const approvedCount = leads.filter((lead) => getStatusKey(lead) === 'approved').length;
  const sentCount = leads.filter((lead) => getStatusKey(lead) === 'sent').length;

  const perLeadTimes = generatedInRange
    .map((lead) => Number(lead.generation_seconds_per_lead))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgGenTimePerLead =
    perLeadTimes.length > 0 ? perLeadTimes.reduce((sum, value) => sum + value, 0) / perLeadTimes.length : null;

  const runsById = new Map();
  generatedInRange.forEach((lead) => {
    const runId = lead.generation_run_id;
    if (!runId) {
      return;
    }
    if (!runsById.has(runId)) {
      runsById.set(runId, {
        generated: Number(lead.generation_generated_count) || 0,
        requested: Number(lead.generation_requested_count) || 0,
        elapsed: Number(lead.generation_elapsed_seconds) || 0,
        generatedAt: lead.generated_at || null,
      });
    }
  });
  const runs = Array.from(runsById.values());
  const avgLeadsPerRun = runs.length ? runs.reduce((sum, run) => sum + (run.generated || 0), 0) / runs.length : null;
  const totalRequested = runs.reduce((sum, run) => sum + (run.requested || 0), 0);
  const totalGeneratedFromRuns = runs.reduce((sum, run) => sum + (run.generated || 0), 0);
  const successRate = totalRequested > 0 ? (totalGeneratedFromRuns / totalRequested) * 100 : null;

  const rangeStart = getRangeStart();
  let daysInRange = 1;
  if (rangeStart) {
    daysInRange = Math.max(1, (Date.now() - rangeStart.getTime()) / (24 * 60 * 60 * 1000));
  } else {
    const sentDates = sentLeads.map((lead) => parseTimestamp(lead.sent_at)).filter(Boolean).sort((a, b) => a - b);
    if (sentDates.length > 1) {
      daysInRange = Math.max(1, (Date.now() - sentDates[0].getTime()) / (24 * 60 * 60 * 1000));
    }
  }

  return {
    emailsSent: sentInRange.length,
    leadsGenerated: overviewRange === 'all' ? leads.length : generatedInRange.length,
    avgGenTimePerLead,
    queuedNow,
    draftsCount,
    approvedCount,
    sentCount,
    avgEmailsPerDay: sentInRange.length / daysInRange,
    avgLeadsPerRun,
    queueEtaSeconds: queuedNow * 90,
    successRate,
    lastSentAt: sentLeads
      .map((lead) => parseTimestamp(lead.sent_at))
      .filter(Boolean)
      .sort((a, b) => b - a)[0],
    lastGeneratedAt: leads
      .map((lead) => parseTimestamp(getGeneratedTimestamp(lead)))
      .filter(Boolean)
      .sort((a, b) => b - a)[0],
    sentTrend: buildTrendBuckets(leads, 'sent'),
    generatedTrend: buildTrendBuckets(leads, 'generated'),
  };
};

const renderKpiCard = (label, value, helper = '') => `
  <article class="overview-kpi">
    <p class="overview-kpi__label">${escapeHtml(label)}</p>
    <p class="overview-kpi__value">${escapeHtml(value)}</p>
    ${helper ? `<p class="overview-kpi__helper">${escapeHtml(helper)}</p>` : ''}
  </article>
`;

const renderOverview = (allLeads) => {
  const stats = calculateOverviewStats(allLeads);
  const filterButtons = Object.entries(OVERVIEW_RANGES)
    .map(
      ([key, cfg]) => `
      <button type="button" class="overview-filter${overviewRange === key ? ' is-active' : ''}" data-overview-range="${key}">
        ${cfg.label}
      </button>`
    )
    .join('');
  const generatorActive = Boolean(generatorProgressCache?.active);
  const generatorMessage = generatorProgressCache?.message || 'Idle';
  const progressCurrent = Number(generatorProgressCache?.current || 0);
  const progressTotal = Number(generatorProgressCache?.total || 0);
  const generatorProgressText =
    generatorActive && progressTotal > 0 ? `${progressCurrent}/${progressTotal}` : generatorMessage;

  container.innerHTML = `
    <div class="overview-page">
      <div class="overview-topbar">
        <div class="overview-topbar__filters">${filterButtons}</div>
        <div class="overview-topbar__meta">
          <span>Last updated: ${escapeHtml(formatChicagoTime(new Date()))} (Chicago)</span>
        </div>
      </div>

      <section class="overview-kpi-grid">
        ${renderKpiCard('Emails sent', String(stats.emailsSent))}
        ${renderKpiCard('Leads generated', String(stats.leadsGenerated))}
        ${renderKpiCard('Avg generation time / lead', formatDuration(stats.avgGenTimePerLead))}
        ${renderKpiCard('Queued now', String(stats.queuedNow), `ETA ${formatCompactDuration(stats.queueEtaSeconds)}`)}
      </section>

      <section class="overview-kpi-grid overview-kpi-grid--secondary">
        ${renderKpiCard('Drafts count', String(stats.draftsCount))}
        ${renderKpiCard('Queued count', String(stats.queuedNow))}
        ${renderKpiCard('Sent count', String(stats.sentCount))}
        ${renderKpiCard('Avg emails sent / day', Number.isFinite(stats.avgEmailsPerDay) ? stats.avgEmailsPerDay.toFixed(1) : 'N/A')}
        ${renderKpiCard('Avg leads generated / run', Number.isFinite(stats.avgLeadsPerRun) ? stats.avgLeadsPerRun.toFixed(1) : 'N/A')}
        ${renderKpiCard('Success rate', Number.isFinite(stats.successRate) ? `${stats.successRate.toFixed(0)}%` : 'N/A')}
      </section>

      <section class="overview-grid-2">
        ${renderTrendCard('Generated leads trend', stats.generatedTrend)}
        ${renderTrendCard('Emails sent trend', stats.sentTrend)}
      </section>

      <section class="overview-grid-2">
        <section class="overview-card">
          <div class="overview-card__header"><h4>Pipeline</h4></div>
          <div class="overview-list">
            <div class="overview-list__row"><span>Drafted</span><strong>${stats.draftsCount}</strong></div>
            <div class="overview-list__row"><span>Approved</span><strong>${stats.approvedCount}</strong></div>
            <div class="overview-list__row"><span>Queued</span><strong>${stats.queuedNow}</strong></div>
            <div class="overview-list__row"><span>Sent</span><strong>${stats.sentCount}</strong></div>
          </div>
        </section>
        <section class="overview-card">
          <div class="overview-card__header"><h4>System health</h4></div>
          <div class="overview-list">
            <div class="overview-list__row"><span>Generator</span><strong>${escapeHtml(generatorActive ? 'Active' : 'Idle')}</strong></div>
            <div class="overview-list__row"><span>Generator progress</span><strong>${escapeHtml(generatorProgressText)}</strong></div>
            <div class="overview-list__row"><span>Send queue</span><strong>${escapeHtml(stats.queuedNow > 0 ? 'Queued' : 'Idle')}</strong></div>
            <div class="overview-list__row"><span>Last generated</span><strong>${escapeHtml(formatChicagoDateTime(stats.lastGeneratedAt))}</strong></div>
            <div class="overview-list__row"><span>Last email sent</span><strong>${escapeHtml(formatChicagoDateTime(stats.lastSentAt))}</strong></div>
          </div>
        </section>
      </section>
    </div>
  `;

  container.querySelectorAll('[data-overview-range]').forEach((button) => {
    button.addEventListener('click', () => {
      overviewRange = button.getAttribute('data-overview-range') || '7d';
      renderLeads();
    });
  });
};

const renderStatusSelect = (lead, currentStatus) => {
  const placeId = lead.place_id || '';
  const isDisabled = !placeId;
  return `
    <select class="mock-lead-bar__select" data-status="${escapeHtml(placeId)}" ${isDisabled ? 'disabled' : ''}>
      <option value="Drafted"${currentStatus === 'Drafted' ? ' selected' : ''}>Drafted</option>
      <option value="Approved"${currentStatus === 'Approved' ? ' selected' : ''}>Approved</option>
    </select>
  `;
};

const SENT_TAB_STATUSES = ['sent', 'queued'];

const renderSentStatusControls = (lead) => {
  const placeId = lead.place_id || '';
  const isDisabled = !placeId;
  const normalizedStatus = (lead.status || 'queued').toLowerCase();
  return `
    <div class="mock-lead-bar__sent-wrapper">
      <span class="mock-lead-bar__open ${getOpenStateClass(lead)}" title="${escapeHtml(getOpenStateLabel(lead))}" aria-label="${escapeHtml(getOpenStateLabel(lead))}">👁</span>
      <select class="mock-lead-bar__select mock-lead-bar__select--sent" data-status-sent="${escapeHtml(placeId)}" ${isDisabled ? 'disabled' : ''}>
        <option value="queued"${normalizedStatus === 'queued' ? ' selected' : ''}>Queued</option>
        <option value="sent"${normalizedStatus === 'sent' ? ' selected' : ''}>Sent</option>
      </select>
    </div>
  `;
};

const getOpenState = (lead) => {
  if (lead.email_open_state === 'unknown') {
    return 'unknown';
  }
  if (lead.email_opened) {
    return 'opened';
  }
  if (lead.email_open_checked_at) {
    return 'unopened';
  }
  return 'unknown';
};

const getOpenStateClass = (lead) => {
  const state = getOpenState(lead);
  return `mock-lead-bar__open--${state}`;
};

const getOpenStateLabel = (lead) => {
  const state = getOpenState(lead);
  if (state === 'opened') {
    return 'Email opened';
  }
  if (state === 'unopened') {
    return 'Not opened yet';
  }
  return 'Open status pending';
};

const queueAllLeads = () => {
  cachedLeads = cachedLeads.map((lead) => {
    if ((lead.status || '').toLowerCase() === 'sent') {
      return lead;
    }
    return { ...lead, status: 'Queued' };
  });
};

const renderLeadSummary = (lead, index, isSentTab) => {
  const city = lead.city || (lead.address || '').split(',')[1]?.trim() || '—';
  const category = lead.category || lead.business_type || 'General';
  const email = lead.email || 'no email';
  const aboutCopy = lead.about || 'Description pending from the generator.';
  const emailBody = lead.email_body || 'Email copy is being drafted by the generator.';
  const status = lead.status || 'Drafted';
  const deleteButton =
    !isSentTab && lead.place_id
      ? `<button type="button" class="mock-lead-bar__delete" data-delete="${lead.place_id}">Delete</button>`
      : '';
  const statusControl = isSentTab
    ? `${renderSentStatusControls(lead)}`
    : `${renderStatusSelect(lead, status)} ${deleteButton}`;

  return `
    <details class="mock-lead-bar" data-lead-index="${index}">
      <summary class="mock-lead-bar__summary">
        <span class="mock-lead-bar__text">${escapeHtml(lead.name || 'Unknown')}</span>
        <span class="mock-lead-bar__text">${escapeHtml(city)}</span>
        <span class="mock-lead-bar__text">${escapeHtml(category)}</span>
        <span class="mock-lead-bar__text mock-lead-bar__text--email">${escapeHtml(email)}</span>
        <span class="mock-lead-bar__text mock-lead-bar__text--status">${statusControl}</span>
      </summary>
      <div class="mock-lead-bar__details">
        <label>
          <span>About</span>
          <textarea>${escapeHtml(aboutCopy)}</textarea>
        </label>
        <label>
          <span>Email</span>
          <textarea>${escapeHtml(`Student Partnership\n\n${emailBody}`)}</textarea>
        </label>
      </div>
    </details>
  `;
};

const filterMatches = (lead) => {
  const term = searchTerm.trim().toLowerCase();
  if (!term) {
    return true;
  }
  const valuesToSearch = [lead.name, lead.city, lead.address, lead.category, lead.business_type, lead.email, lead.phone];
  return valuesToSearch.some((value) => String(value ?? '').toLowerCase().includes(term));
};

const updateTabState = () => {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.leadTab === activeTab;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
};

const refreshLeads = async () => {
  if (!container) {
    return [];
  }
  if (refreshInProgress) {
    return cachedLeads;
  }
  refreshInProgress = true;
  try {
    try {
      const progressResp = await fetch(`${endpoint}/generate/progress`, { cache: 'no-store' });
      if (progressResp.ok) {
        generatorProgressCache = await progressResp.json();
      }
    } catch {
      // Progress endpoint may not be available on older deployments.
    }
    const leadEndpoint = `${endpoint}/leads`;
    const response = await fetch(leadEndpoint, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load leads: ${response.status}`);
    }
    const data = await response.json();
    cachedLeads = Array.isArray(data) ? data : [];
    if (activeTab === 'sent') {
      await refreshOpenStatuses();
    }
    renderLeads();
    return cachedLeads;
  } finally {
    refreshInProgress = false;
  }
};

const renderLeads = () => {
  if (!container) {
    return;
  }
  container.classList.toggle('lead-dashboard__mock--overview', activeTab === 'dashboard');
  if (activeTab === 'dashboard') {
    renderOverview(cachedLeads);
    updateTabState();
    return;
  }
  const sourceLeads = Array.isArray(cachedLeads) && cachedLeads.length ? cachedLeads : SAMPLE_LEADS;
  const filtered = sourceLeads.filter((lead) => {
    if (!filterMatches(lead)) {
      return false;
    }
    if (activeTab === 'sent') {
      const statusKey = (lead.status || 'queued').toLowerCase();
      return SENT_TAB_STATUSES.includes(statusKey);
    }
    return (lead.status || '').toLowerCase() !== 'sent';
  });
  if (!filtered.length) {
    container.innerHTML = `<p class="lead-dashboard__empty">No leads match that search term.</p>`;
    return;
  }
  const isSentTab = activeTab === 'sent';
  container.innerHTML = filtered.map((lead, idx) => renderLeadSummary(lead, idx, isSentTab)).join('');
  container.querySelectorAll('details.mock-lead-bar').forEach((details) => {
    details.open = false;
  });
  container.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = button.getAttribute('data-delete');
      button.setAttribute('disabled', 'disabled');
      try {
        await deleteLead(id);
        await refreshLeads();
      } catch (error) {
        console.error('Delete failed', error);
        alert('Unable to delete that lead.');
      } finally {
        button.removeAttribute('disabled');
      }
    });
  });
  if (!isSentTab) {
    container.querySelectorAll('[data-status]').forEach((select) => {
      select.addEventListener('change', async () => {
        const placeId = select.getAttribute('data-status');
        try {
          await fetch(`${endpoint}/leads/${placeId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: select.value }),
          });
          await refreshLeads();
        } catch (error) {
          console.error('Status update failed', error);
          select.value = select.value === 'Drafted' ? 'Approved' : 'Drafted';
        }
      });
    });
  } else {
    container.querySelectorAll('[data-status-sent]').forEach((select) => {
      select.addEventListener('change', async () => {
        const placeId = select.getAttribute('data-status-sent');
        try {
          await fetch(`${endpoint}/leads/${placeId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: select.value }),
          });
          await refreshLeads();
        } catch (error) {
          console.error('Sent status update failed', error);
        }
      });
    });
  }
  updateTabState();
};

const mergeOpenStatuses = (statuses) => {
  if (!statuses || typeof statuses !== 'object') {
    return;
  }
  cachedLeads = cachedLeads.map((lead) => {
    const placeId = lead.place_id || '';
    const status = statuses[placeId];
    if (!status) {
      return lead;
    }
    return {
      ...lead,
      email_opened: Boolean(status.opened),
      email_opened_at: status.opened_at || lead.email_opened_at || null,
      email_open_checked_at: status.checked_at || lead.email_open_checked_at || null,
      email_open_state: status.state || lead.email_open_state || null,
    };
  });
};

const refreshOpenStatuses = async () => {
  if (openStatusRefreshInFlight) {
    return;
  }
  const placeIds = cachedLeads
    .filter((lead) => SENT_TAB_STATUSES.includes((lead.status || '').toLowerCase()) && lead.place_id)
    .map((lead) => lead.place_id);
  if (!placeIds.length) {
    return;
  }
  openStatusRefreshInFlight = true;
  try {
    const response = await fetch(`${endpoint}/leads/open-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_ids: placeIds }),
    });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    mergeOpenStatuses(payload.statuses);
  } catch (error) {
    console.error('Open status refresh failed', error);
  } finally {
    openStatusRefreshInFlight = false;
  }
};

const deleteLead = async (id) => {
  const deleteEndpoint = `${endpoint}/leads/${id}`;
  const response = await fetch(deleteEndpoint, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Unable to delete lead');
  }
  return response.json();
};

const clearSendStatusPolling = () => {
  if (sendStatusPoll) {
    clearInterval(sendStatusPoll);
    sendStatusPoll = null;
  }
};

const startSendStatusPolling = () => {
  clearSendStatusPolling();
  sendStatusPoll = setInterval(async () => {
    await refreshLeads();
    const stillQueued = cachedLeads.some((lead) => SENT_TAB_STATUSES.includes((lead.status || '').toLowerCase()));
    if (!stillQueued) {
      clearSendStatusPolling();
    }
  }, 2800);
};

const attachSearchListener = () => {
  if (!searchInput || searchInitialized) {
    return;
  }
  searchInitialized = true;
  searchInput.addEventListener('input', (event) => {
    searchTerm = event.target.value;
    renderLeads();
  });
};

const attachTabListeners = () => {
  if (!tabButtons.length || tabsInitialized) {
    return;
  }
  tabsInitialized = true;
  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      activeTab = button.dataset.leadTab || 'all';
      renderLeads();
    });
  });
  updateTabState();
};

const attachSendButton = () => {
  if (!sendButton || sendInitialized) {
    return;
  }
  sendInitialized = true;
  sendButton.addEventListener('click', async () => {
    sendButton.disabled = true;
    if (sendStatusEl) {
      sendStatusEl.textContent = 'Queueing send...';
    }
    try {
      const resp = await fetch(`${endpoint}/send`, { method: 'POST' });
      const payload = await resp.json();
      if (!resp.ok) {
        throw new Error(payload.error || 'Unable to queue send');
      }
      if (sendStatusEl) {
        sendStatusEl.textContent = payload.message || 'Send queue started';
      }
      activeTab = 'sent';
      queueAllLeads();
      renderLeads();
      startSendStatusPolling();
    } catch (error) {
      console.error('Send queue failed', error);
      if (sendStatusEl) {
        sendStatusEl.textContent = error.message || 'Unable to send right now';
      }
    } finally {
      sendButton.disabled = false;
    }
  });
};

const attachReloadButton = () => {
  if (!reloadButton || reloadInitialized) {
    return;
  }
  reloadInitialized = true;
  reloadButton.addEventListener('click', () => {
    window.location.reload();
  });
};

const attachExportButton = () => {
  if (!exportSentButton || exportInitialized) {
    return;
  }
  exportInitialized = true;
  exportSentButton.addEventListener('click', async () => {
    if (!cachedLeads.length) {
      try {
        await refreshLeads();
      } catch {
        // refreshLeads already handles UI errors
      }
    }

    const sentRows = (cachedLeads.length ? cachedLeads : SAMPLE_LEADS).filter((lead) =>
      SENT_TAB_STATUSES.includes(getStatusKey(lead))
    );

    if (!sentRows.length) {
      if (sendStatusEl) {
        sendStatusEl.textContent = 'No sent/queued leads to export';
      }
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`sent-leads-${stamp}.csv`, buildSentCsv(sentRows));
    if (sendStatusEl) {
      sendStatusEl.textContent = `Exported ${sentRows.length} row${sentRows.length === 1 ? '' : 's'}`;
    }
  });
};

const init = async () => {
  if (!container) {
    return;
  }
  try {
    const leadEndpoint = `${endpoint}/leads`;
    const response = await fetch(leadEndpoint, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load leads: ${response.status}`);
    }
    const data = await response.json();
    cachedLeads = Array.isArray(data) ? data : [];
    renderLeads();
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="lead-dashboard__empty">Unable to load leads right now. Try running the generator again.</p>`;
  }
};

const bootstrap = () => {
  attachSearchListener();
  attachTabListeners();
  attachSendButton();
  attachExportButton();
  attachReloadButton();
  init();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
