const DEFAULT_SOURCE = './data/leads.json';
const DASHBOARD_SELECTOR = '[data-lead-dashboard]';
const container = document.querySelector(DASHBOARD_SELECTOR);

const iconChevron = `<svg viewBox="0 0 10 6" role="presentation" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatCell = (value, placeholder = '—') => escapeHtml(value || placeholder);

const renderRow = (lead, index) => {
  const email = lead.email || '';
  const mapUrl = lead.google_maps_url ? escapeHtml(lead.google_maps_url) : '';
  const mapLink = mapUrl
    ? `<a class="lead-row__link" href="${mapUrl}" target="_blank" rel="noreferrer">View map</a>`
    : 'n/a';
  const aboutCopy = lead.about?.trim() || 'Description pending from the generator.';
  return `
    <div class="lead-row" data-lead-index="${index}">
      <button type="button" class="lead-row__summary">
        <span class="lead-row__cell">${formatCell(lead.name)}</span>
        <span class="lead-row__cell">${formatCell(lead.address)}</span>
        <span class="lead-row__cell">${formatCell(lead.phone, 'no phone')}</span>
        <span class="lead-row__cell">${mapLink}</span>
        <span class="lead-row__cell">${formatCell(lead.email, 'no email')}</span>
      </button>
      <div class="lead-row__details">
        <p><strong>About:</strong> ${escapeHtml(aboutCopy)}</p>
        <p><strong>Email:</strong> <a class="lead-row__link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
        <p><strong>Subject line:</strong> ${escapeHtml(lead.email_subject)}</p>
        <p><strong>Email body:</strong></p>
        <pre><code>${escapeHtml(lead.email_body)}</code></pre>
        <button type="button" data-copy-body="${index}">Copy body</button>
      </div>
    </div>
  `;
};

const renderHeader = () => `
  <div class="lead-table__header">
    <span>Name</span>
    <span>Address</span>
    <span>Phone</span>
    <span>Map</span>
    <span>Email</span>
  </div>
`;

const renderLeads = (leads) => {
  if (!container) {
    return;
  }
  if (!Array.isArray(leads) || leads.length === 0) {
    container.innerHTML = '<p class="lead-dashboard__empty">No leads yet. Run the generator to fill this block.</p>';
    return;
  }
  container.innerHTML = `
    <div class="lead-dashboard__table">
      ${renderHeader()}
      ${leads.map((lead, index) => renderRow(lead, index)).join('')}
    </div>
  `;
  container.querySelectorAll('.lead-row__summary').forEach((button) => {
    button.addEventListener('click', () => {
      const parent = button.closest('.lead-row');
      if (!parent) {
        return;
      }
      parent.classList.toggle('is-open');
    });
  });
  container.querySelectorAll('[data-copy-body]').forEach((button) => {
    button.addEventListener('click', async () => {
      const index = button.getAttribute('data-copy-body');
      const lead = leads[Number(index)];
      if (!lead) {
        return;
      }
      try {
        await navigator.clipboard.writeText(lead.email_body || '');
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = 'Copy body';
        }, 2000);
      } catch (error) {
        console.error('Clipboard copy failed', error);
      }
    });
  });
};

const fetchLeads = async () => {
  if (!container) {
    return [];
  }
  const source = container.dataset.source || DEFAULT_SOURCE;
  const response = await fetch(source, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load leads: ${response.status}`);
  }
  return response.json();
};

const init = async () => {
  if (!container) {
    return;
  }
  try {
    const data = await fetchLeads();
    renderLeads(data);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="lead-dashboard__empty">Unable to load leads right now. Try running the generator again.</p>`;
  }
};

init();
