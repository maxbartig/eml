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
const reloadButton = document.getElementById('reloadLeadsButton');

let cachedLeads = [];
let searchTerm = '';
let activeTab = 'all';
let tabsInitialized = false;
let searchInitialized = false;
let sendInitialized = false;
let reloadInitialized = false;
let refreshInProgress = false;
let sendStatusPoll = null;

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
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }
  return parsed.toLocaleString();
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
      <select class="mock-lead-bar__select mock-lead-bar__select--sent" data-status-sent="${escapeHtml(placeId)}" ${isDisabled ? 'disabled' : ''}>
        <option value="queued"${normalizedStatus === 'queued' ? ' selected' : ''}>Queued</option>
        <option value="sent"${normalizedStatus === 'sent' ? ' selected' : ''}>Sent</option>
      </select>
    </div>
  `;
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
    const leadEndpoint = `${endpoint}/leads`;
    const response = await fetch(leadEndpoint, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load leads: ${response.status}`);
    }
    const data = await response.json();
    cachedLeads = Array.isArray(data) ? data : [];
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
  attachReloadButton();
  init();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
