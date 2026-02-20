const phrases = [
  'Modern Websites Built for Local Businesses',
  'Student-owned, Central Wisconsin built',
  'Clean. Responsive. Lead-gen ready.',
  'Affordable digital presence for service brands',
  'Evergreen Media Labs fuels local growth'
];
const textEl = document.getElementById('dynamicText');
let index = 0;

const chatQuestions = [
  {
    question: 'What types of businesses do you build for?',
    answer:
      'We build sites for landscaping, lawn care, cleaning, contractors, and other Central Wisconsin service brands that need a modern, lead-ready presence.'
  },
  {
    question: 'How fast can you launch a site?',
    answer: 'Typically we deliver a new site in 2·3 weeks with clear checkpoints so you can approve assets as they arrive.'
  },
  {
    question: 'Do you include SEO and lead capture?',
    answer: 'Every build includes basic local SEO, metadata, and lightweight lead-capture forms that deliver submissions to your inbox instantly.'
  },
  {
    question: 'How much does it cost?',
    answer: 'We offer locally affordable packages for small businesses—request a consultation for an exact quote and we will tailor the scope.'
  },
  {
    question: 'How do we get started?',
    answer: 'Hit “Request a Free Consultation,” share your service focus, and we will plan the site, timelines, and approvals together.'
  }
];

function cyclePhrase() {
  if (!textEl) return;
  textEl.classList.add('fade-out');
  setTimeout(() => {
    index = (index + 1) % phrases.length;
    textEl.textContent = phrases[index];
    textEl.classList.remove('fade-out');
  }, 650);
}

function addChatMessage(message, sender = 'bot') {
  const chatBody = document.getElementById('chatBody');
  if (!chatBody) return;
  const messageEl = document.createElement('p');
  messageEl.className = `chat-message ${sender}`;
  messageEl.textContent = message;
  chatBody.appendChild(messageEl);
  chatBody.scrollTop = chatBody.scrollHeight;
}

function handleQuestion(question) {
  const normalized = question.trim();
  const matched = chatQuestions.find((q) => q.question.toLowerCase() === normalized.toLowerCase());
  if (matched) {
    addChatMessage(question, 'user');
    setTimeout(() => {
      addChatMessage(matched.answer, 'bot');
    }, 250);
  }
}

function openChat() {
  const chatWidget = document.getElementById('chatWidget');
  if (chatWidget) chatWidget.classList.add('open');
  addChatMessage('How can Evergreen Media Labs help you today?', 'bot');
}

function closeChat() {
  const chatWidget = document.getElementById('chatWidget');
  if (chatWidget) {
    chatWidget.classList.remove('open');
    const chatBody = document.getElementById('chatBody');
    if (chatBody) chatBody.innerHTML = '';
  }
}

function initChat() {
  const trigger = document.getElementById('chatTrigger');
  const close = document.getElementById('chatClose');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const suggestionButtons = document.querySelectorAll('#chatSuggestions button');
  const menuToggle = document.getElementById('menuToggle');
  const mobileDrawer = document.getElementById('mobileDrawer');

  if (trigger) trigger.addEventListener('click', openChat);
  if (close) close.addEventListener('click', closeChat);

  suggestionButtons.forEach((btn) => {
    btn.addEventListener('click', () => handleQuestion(btn.dataset.question));
  });

  if (form && input) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value;
      if (!value) return;
      handleQuestion(value);
      input.value = '';
    });
  }

  const modal = document.getElementById('contactModal');
  const openContact = document.querySelectorAll('[data-contact]');
  const closeContact = document.getElementById('contactClose');
  const contactForm = document.getElementById('contactForm');
  const contactMessage = document.getElementById('contactMessage');

  function openModal() {
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  if (openContact.length) {
    openContact.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        openModal();
      });
    });
  }

  if (closeContact) {
    closeContact.addEventListener('click', closeModal);
  }

  if (modal) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });
  }

  if (contactForm && contactMessage) {
    contactForm.addEventListener('submit', (event) => {
      event.preventDefault();
      contactMessage.textContent = 'Thanks! You will hear from us within 24 hours with next steps.';
      contactMessage.classList.add('visible');
      contactForm.reset();
      setTimeout(closeModal, 2500);
    });
  }

  function closeDrawer() {
    if (!mobileDrawer || !menuToggle) return;
    mobileDrawer.style.display = 'none';
    menuToggle.classList.remove('open');
    mobileDrawer.setAttribute('aria-hidden', 'true');
  }

  function openDrawer() {
    if (!mobileDrawer || !menuToggle) return;
    mobileDrawer.style.display = 'flex';
    menuToggle.classList.add('open');
    mobileDrawer.setAttribute('aria-hidden', 'false');
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      if (!mobileDrawer) return;
      if (mobileDrawer.style.display === 'flex') {
        closeDrawer();
      } else {
        openDrawer();
      }
    });
  }

  document.querySelectorAll('.mobile-drawer nav a').forEach((link) => {
    link.addEventListener('click', () => {
      closeDrawer();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer();
      closeModal();
    }
  });

  document.querySelectorAll('a[data-scroll]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const selector = link.dataset.scroll;
      if (!selector) return;
      const targetNode = document.querySelector(selector);
      if (targetNode) {
        targetNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  });
}

if (textEl) {
  setInterval(cyclePhrase, 4000);
}

initChat();
