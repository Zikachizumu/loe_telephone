/* ==========================================================================
   loe_telephone — web/js/app.js
   --------------------------------------------------------------------------
   NUI beyni: ekran yönlendirme, server köprüsü (NUI callback'leri), gelen
   arama/mesaj bildirimleri, kamera vizörü tetikleyicileri ve galeri için
   yerel (IndexedDB) depolama. Sunucuya fotoğraf YÜKLENMEZ — bkz Galeri bölümü.

   GÜVENLİK: sunucudan/başka oyuncudan gelen her metin (isim, mesaj, numara)
   `esc()` ile HTML-escape edilmeden innerHTML'e basılmaz — bkz. esc().
   ========================================================================== */

const RESOURCE = (window.GetParentResourceName && window.GetParentResourceName()) || 'loe_telephone';

/* ------------------------------------------------------------------------ */
/* SUNUCU KÖPRÜSÜ (NUI callback)                                            */
/* ------------------------------------------------------------------------ */

async function post(action, data) {
  try {
    const res = await fetch(`https://${RESOURCE}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data === undefined ? {} : data),
    });
    return await res.json();
  } catch (err) {
    console.error(`[loe_telephone] post(${action}) hata:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* DURUM (STATE)                                                            */
/* ------------------------------------------------------------------------ */

const State = {
  numbers: [],       // [{ number, active }]
  activeNumber: null,
  maxLines: 3,
  contacts: [],       // [{ id, number, name }]
  contactSearch: '',
  newMessageContactSearch: '',
  currentThreadNumber: null,
  activeCallId: null,
  callStartedAt: null,
  callTimerHandle: null,
  cameraOpen: false,
  currentPhotoId: null,
  cameraReturnView: 'home',
  cameraMedia: 'photo',      // 'photo' | 'video'
  cameraMode: 'full',        // 'full' (tam ekran) | 'story' (9:16) | 'post' (1:1 / 1.91:1)
  cameraPostRatio: '1:1',
};

// Kamera ölçekleri ve Instagram oranları (genişlik / yükseklik). Tam ekran
// kırpılmaz: ekranın kendisi (ör. 16:9).
const CAMERA_MODES = ['full', 'story', 'post'];
const CAMERA_RATIOS = { '9:16': 9 / 16, '1:1': 1, '1.91:1': 1.91 };
const CAMERA_POST_RATIOS = ['1:1', '1.91:1'];

function applyState(s) {
  if (!s) return;
  State.numbers = s.numbers || [];
  State.activeNumber = s.active || null;
  State.maxLines = s.maxLines || State.maxLines;
  renderSettingsLines();
}

/* ------------------------------------------------------------------------ */
/* YARDIMCILAR                                                              */
/* ------------------------------------------------------------------------ */

/** HTML-escape — sunucudan/başka oyuncudan gelen metinleri innerHTML'e
 *  basmadan önce ZORUNLU kullanılır (isim, mesaj gövdesi, vb.). */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtNumber(n) {
  if (!n) return '—';
  const half = Math.ceil(n.length / 2);
  return `${n.slice(0, half)} ${n.slice(half)}`;
}

function initials(name) {
  if (!name) return '#';
  const parts = name.trim().split(/\s+/);
  const chars = parts.slice(0, 2).map((p) => p[0]);
  return chars.join('').toUpperCase();
}

function contactNameFor(number) {
  const c = State.contacts.find((c) => c.number === number);
  return c ? c.name : null;
}

function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'şimdi';
  if (diff < 3600) return `${Math.floor(diff / 60)} dk`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa`;
  if (diff < 172800) return 'dün';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

function showToast(type, message) {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type || ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ------------------------------------------------------------------------ */
/* SAAT (durum çubuğu)                                                      */
/* ------------------------------------------------------------------------ */

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('status-time').textContent = time;
}
setInterval(tickClock, 1000 * 15);

/* ------------------------------------------------------------------------ */
/* EKRAN YÖNLENDİRME                                                        */
/* ------------------------------------------------------------------------ */

const root = document.getElementById('phone-root');
const frame = document.querySelector('.phone-frame');

function switchView(name) {
  document.querySelectorAll('.screen-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });

  if (name !== 'camera' && State.cameraOpen) closeCamera();

  if (name === 'messages') loadThreads();
  if (name === 'contacts') loadContacts();
  if (name === 'new-message') openNewMessageScreen();
  if (name === 'settings') renderSettingsLines();
  if (name === 'phone') loadCallHistory();
  if (name === 'gallery') renderGallery();
  if (name === 'camera') openCamera();
  if (name !== 'photo') releaseVideoPreview();
  if (name === 'appstore') renderStore();
  if (name === 'calculator') calcRender();
  if (name === 'notes') renderNotes();
  if (name === 'telegram') loadTelegramGroups();
  if (name === 'banka') bankOpenOverview();
  if (name === 'banka-deposit' || name === 'banka-withdraw' || name === 'banka-transfer' || name === 'banka-donate') bankRenderForms();
  if (name === 'banka-history') bankRenderHistory();
  if (name === 'banka-fines') bankOpenFines();
  if (name === 'social') openSocialHome();
  if (name === 'lifegram') openLifegram();
}

document.addEventListener('click', (ev) => {
  const openBtn = ev.target.closest('[data-open]');
  if (openBtn) {
    const target = openBtn.dataset.open;
    const catalogApp = APP_CATALOG.find((a) => (a.view || a.id) === target);
    if (catalogApp && catalogApp.external) {
      post('openMarketplace');
      closePhoneUI();
      return;
    }
    if (target === 'camera') {
      State.cameraReturnView = 'home';
      State.cameraMedia = 'photo';
      State.cameraMode = 'full';
    }
    return switchView(target);
  }

  const backBtn = ev.target.closest('[data-back]');
  if (backBtn) return switchView(backBtn.dataset.back);
});

/* ------------------------------------------------------------------------ */
/* TELEFON — TUŞ TAKIMI + SON ARAMALAR                                      */
/* ------------------------------------------------------------------------ */

let dialBuffer = '';

function updateDialDisplay() {
  document.getElementById('dial-display').textContent = dialBuffer;
  const nameEl = document.getElementById('dial-contact-name');
  const name = dialBuffer.length === 8 ? contactNameFor(dialBuffer) : null;
  nameEl.textContent = name || '';
}

function renderKeypad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  const grid = document.getElementById('keypad');
  grid.innerHTML = '';
  keys.forEach((k) => {
    const btn = document.createElement('button');
    btn.className = 'key-btn';
    btn.textContent = k;
    btn.addEventListener('click', () => {
      if (dialBuffer.length >= 8) return;
      dialBuffer += k;
      updateDialDisplay();
    });
    grid.appendChild(btn);
  });
}
renderKeypad();

document.getElementById('dial-display').addEventListener('click', () => {
  dialBuffer = dialBuffer.slice(0, -1);
  updateDialDisplay();
});

document.getElementById('keypad-del').addEventListener('click', () => {
  dialBuffer = dialBuffer.slice(0, -1);
  updateDialDisplay();
});

// Fiziksel klavyenin Numpad 0-9 ve Backspace tuşlarıyla numara girişi (tuş takımı açıkken).
function isDialpadActive() {
  const phoneView = document.querySelector('.screen-view[data-view="phone"]');
  if (!phoneView || !phoneView.classList.contains('active')) return false;
  const keypadPanel = document.getElementById('tab-keypad');
  if (!keypadPanel || keypadPanel.classList.contains('hidden')) return false;
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return false;
  return true;
}

document.addEventListener('keydown', (ev) => {
  if (ev.code === 'Backspace' || ev.code === 'Delete') {
    if (!isDialpadActive()) return;
    ev.preventDefault();
    dialBuffer = dialBuffer.slice(0, -1);
    updateDialDisplay();
    return;
  }
  if (!ev.code || ev.code.indexOf('Numpad') !== 0) return;
  const digit = ev.code.slice(6);
  if (!/^[0-9]$/.test(digit)) return;
  if (!isDialpadActive()) return;
  if (dialBuffer.length >= 8) return;
  ev.preventDefault();
  dialBuffer += digit;
  updateDialDisplay();
});

document.querySelectorAll('#phone-tabs .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#phone-tabs .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== tab));
    if (tab === 'recents') loadCallHistory();
  });
});

async function placeCall(number) {
  const res = await post('startCall', { number });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Arama başlatılamadı.');
  State.activeCallId = res.callId;
  showActiveCallScreen(res.toNumber, 'ringing');
}

document.getElementById('btn-dial').addEventListener('click', () => {
  if (dialBuffer.length !== 8) return showToast('error', '8 haneli numara gir.');
  placeCall(dialBuffer);
});

async function loadCallHistory() {
  const res = await post('getCallHistory');
  const list = document.getElementById('call-history-list');
  list.innerHTML = '';
  if (!res || !res.success) return;

  if (!res.calls.length) {
    list.innerHTML = '<p class="empty-hint">Henüz arama yok.</p>';
    return;
  }

  res.calls.forEach((c) => {
    const outgoing = c.from_number === res.myNumber;
    const other = outgoing ? c.to_number : c.from_number;
    const label = c.status === 'missed' ? 'Cevapsız' : (outgoing ? 'Giden' : 'Gelen');
    const name = contactNameFor(other) || fmtNumber(other);

    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(contactNameFor(other) || other))}</div>
      <div class="row-main">
        <div class="row-title">${esc(name)}</div>
        <div class="row-sub ${c.status === 'missed' ? 'row-icon missed' : ''}">${esc(label)}${c.duration ? ' · ' + Math.ceil(c.duration / 60) + ' dk' : ''}</div>
      </div>
      <div class="row-meta ${c.status === 'missed' ? 'missed' : ''}">${esc(fmtRelative(c.ts))}</div>
    `;
    li.addEventListener('click', () => placeCall(other));
    list.appendChild(li);
  });
}

/* ------------------------------------------------------------------------ */
/* MESAJLAR                                                                  */
/* ------------------------------------------------------------------------ */

async function loadThreads() {
  const res = await post('getThreads');
  const list = document.getElementById('threads-list');
  const empty = document.getElementById('threads-empty');
  list.innerHTML = '';

  if (!res || !res.success) {
    empty.hidden = false;
    empty.textContent = (res && res.reason) || 'Aktif bir hattın yok.';
    return;
  }

  empty.hidden = res.threads.length > 0;

  res.threads.forEach((t) => {
    const name = contactNameFor(t.other) || fmtNumber(t.other);
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(contactNameFor(t.other) || t.other))}</div>
      <div class="row-main">
        <div class="row-title">${esc(name)}</div>
        <div class="row-sub">${esc(t.lastBody || '')}</div>
      </div>
      <div class="row-meta">
        ${esc(fmtRelative(t.lastAt))}
        ${t.unread > 0 ? `<br/><span class="unread">${esc(t.unread)}</span>` : ''}
      </div>
    `;
    li.addEventListener('click', () => openThread(t.other));
    list.appendChild(li);
  });
}

async function openThread(number) {
  State.currentThreadNumber = number;
  document.getElementById('thread-attach-menu').classList.remove('open');

  const title = document.getElementById('thread-title');
  title.textContent = contactNameFor(number) || fmtNumber(number);

  switchView('thread');
  const res = await post('getThreadMessages', { number });
  renderThreadMessages(res);
}

document.getElementById('btn-new-message').addEventListener('click', () => switchView('new-message'));

/** Metin/fotoğraf/konum içeren bir mesajı balon (bubble) DOM elemanına çevirir. */
function buildMessageBubble(m, out) {
  const b = document.createElement('div');
  b.className = `bubble ${out ? 'out' : 'in'}`;

  if (m.photo_data) {
    const img = document.createElement('img');
    img.className = 'bubble-photo';
    img.src = m.photo_data;
    b.appendChild(img);
  }

  if (m.location) {
    const loc = document.createElement('div');
    loc.className = 'bubble-location';
    loc.innerHTML = '<span class="icon icon-location"></span><span>Konum paylaşıldı</span>';
    const mapBtn = document.createElement('button');
    mapBtn.className = 'bubble-map-btn';
    mapBtn.type = 'button';
    mapBtn.dataset.loc = m.location;
    mapBtn.textContent = 'Haritada Göster';
    loc.appendChild(mapBtn);
    b.appendChild(loc);
  }

  if (m.body) {
    const p = document.createElement('div');
    p.className = 'bubble-text';
    p.textContent = m.body; // textContent -> her zaman güvenli, escape gerekmez
    b.appendChild(p);
  }

  return b;
}

function renderThreadMessages(res) {
  const box = document.getElementById('thread-messages');
  box.innerHTML = '';
  if (!res || !res.success) return;

  const msgs = [...res.messages].reverse();
  msgs.forEach((m) => {
    const out = m.from_number === res.myNumber;
    box.appendChild(buildMessageBubble(m, out));
  });
  box.scrollTop = box.scrollHeight;
}

async function sendCurrentMessage() {
  const input = document.getElementById('thread-input');
  const body = input.value.trim();
  if (!body) return;

  const to = State.currentThreadNumber;
  const res = await post('sendMessage', { to, body });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Mesaj gönderilemedi.');

  input.value = '';
  const box = document.getElementById('thread-messages');
  box.appendChild(buildMessageBubble({ body }, true));
  box.scrollTop = box.scrollHeight;
}

document.getElementById('thread-send').addEventListener('click', sendCurrentMessage);
document.getElementById('thread-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') sendCurrentMessage();
});

/* ------------------------------------------------------------------------ */
/* MESAJLAR — EKLE MENÜSÜ (Canlı Konum Paylaş / Fotoğraf)                   */
/* ------------------------------------------------------------------------ */

document.getElementById('thread-attach-btn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  document.getElementById('thread-attach-menu').classList.toggle('open');
});
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('thread-attach-menu');
  if (!menu.classList.contains('open')) return;
  if (ev.target.closest('#thread-attach-menu') || ev.target.closest('#thread-attach-btn')) return;
  menu.classList.remove('open');
});

document.getElementById('thread-attach-location').addEventListener('click', async () => {
  document.getElementById('thread-attach-menu').classList.remove('open');
  const loc = await post('getMyLocation');
  if (!loc || !loc.success) return showToast('error', 'Konum alınamadı.');

  const to = State.currentThreadNumber;
  const location = `${loc.x.toFixed(1)},${loc.y.toFixed(1)}`;
  const res = await post('sendMessage', { to, body: '', location });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Konum gönderilemedi.');

  const box = document.getElementById('thread-messages');
  box.appendChild(buildMessageBubble({ location }, true));
  box.scrollTop = box.scrollHeight;
});

document.getElementById('thread-attach-photo').addEventListener('click', async () => {
  document.getElementById('thread-attach-menu').classList.remove('open');

  const grid = document.getElementById('thread-photo-grid');
  const empty = document.getElementById('thread-photo-empty');
  grid.innerHTML = '';

  let photos = [];
  try { photos = await GalleryDB.listPhotos(); } catch (e) { /* tarayıcı desteklemiyor olabilir */ }
  empty.hidden = photos.length > 0;

  photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${p.dataUrl}" alt="" />`;
    div.addEventListener('click', async () => {
      closeSheet('thread-photo-sheet');
      const to = State.currentThreadNumber;
      const res = await post('sendMessage', { to, body: '', photo: await compressDataUrl(p.dataUrl) });
      if (!res || !res.success) return showToast('error', (res && res.reason) || 'Fotoğraf gönderilemedi.');

      const box = document.getElementById('thread-messages');
      box.appendChild(buildMessageBubble({ photo_data: p.dataUrl }, true));
      box.scrollTop = box.scrollHeight;
    });
    grid.appendChild(div);
  });

  openSheet('thread-photo-sheet');
});
document.getElementById('thread-photo-backdrop').addEventListener('click', () => closeSheet('thread-photo-sheet'));

document.getElementById('thread-messages').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-loc]');
  if (!btn) return;
  const [x, y] = btn.dataset.loc.split(',').map(Number);
  post('showLocationOnMap', { x, y });
});

/* ------------------------------------------------------------------------ */
/* REHBER                                                                    */
/* ------------------------------------------------------------------------ */

async function loadContacts() {
  const res = await post('getContacts');
  if (!res || !res.success) return;
  State.contacts = res.contacts;
  renderContacts();
  renderNewMessageContacts();
}

function renderContacts() {
  const list = document.getElementById('contacts-list');
  const empty = document.getElementById('contacts-empty');
  list.innerHTML = '';

  const q = State.contactSearch.trim().toLowerCase();
  const rows = q
    ? State.contacts.filter((c) => c.name.toLowerCase().includes(q) || c.number.includes(q))
    : State.contacts;

  empty.hidden = State.contacts.length > 0;
  if (State.contacts.length > 0 && rows.length === 0) {
    list.innerHTML = '<p class="empty-hint">Sonuç bulunamadı.</p>';
    return;
  }

  rows.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="row-main">
        <div class="row-title">${esc(c.name)}</div>
        <div class="row-sub">${esc(fmtNumber(c.number))}</div>
      </div>
      <div class="row-actions">
        <button class="row-action-btn call" title="Ara" data-call="${esc(c.number)}"><span class="icon"></span></button>
        <button class="row-action-btn message" title="Mesaj gönder" data-msg="${esc(c.number)}"><span class="icon"></span></button>
      </div>
    `;
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-call]') || ev.target.closest('[data-msg]')) return;
      openContactForm(c);
    });
    list.appendChild(li);
  });
}

document.getElementById('contacts-list').addEventListener('click', (ev) => {
  const callBtn = ev.target.closest('[data-call]');
  if (callBtn) {
    ev.stopPropagation();
    switchView('phone');
    placeCall(callBtn.dataset.call);
    return;
  }
  const msgBtn = ev.target.closest('[data-msg]');
  if (msgBtn) {
    ev.stopPropagation();
    openThread(msgBtn.dataset.msg);
  }
});

document.getElementById('contact-search').addEventListener('input', (ev) => {
  State.contactSearch = ev.target.value;
  renderContacts();
});

/* ------------------------------------------------------------------------ */
/* MESAJLAR — YENİ MESAJ (Rehberden seç / Numara yaz)                       */
/* ------------------------------------------------------------------------ */

function openNewMessageScreen() {
  document.querySelectorAll('#new-message-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.nmTab === 'rehber'));
  document.querySelectorAll('.nm-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.nmPanel !== 'rehber'));
  document.getElementById('new-message-number-input').value = '';
  State.newMessageContactSearch = '';
  document.getElementById('new-message-contact-search').value = '';
  loadContacts();
}

function renderNewMessageContacts() {
  const list = document.getElementById('new-message-contacts-list');
  const empty = document.getElementById('new-message-contacts-empty');
  list.innerHTML = '';

  const q = State.newMessageContactSearch.trim().toLowerCase();
  const rows = q
    ? State.contacts.filter((c) => c.name.toLowerCase().includes(q) || c.number.includes(q))
    : State.contacts;

  empty.hidden = State.contacts.length > 0;
  if (State.contacts.length > 0 && rows.length === 0) {
    list.innerHTML = '<p class="empty-hint">Sonuç bulunamadı.</p>';
    return;
  }

  rows.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="row-main">
        <div class="row-title">${esc(c.name)}</div>
        <div class="row-sub">${esc(fmtNumber(c.number))}</div>
      </div>
    `;
    li.addEventListener('click', () => openThread(c.number));
    list.appendChild(li);
  });
}

document.getElementById('new-message-contact-search').addEventListener('input', (ev) => {
  State.newMessageContactSearch = ev.target.value;
  renderNewMessageContacts();
});

document.querySelectorAll('#new-message-tabs .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#new-message-tabs .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.nmTab;
    document.querySelectorAll('.nm-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.nmPanel !== tab));
  });
});

document.getElementById('new-message-number-go').addEventListener('click', () => {
  const number = document.getElementById('new-message-number-input').value.replace(/\D/g, '');
  if (number.length !== 8) return showToast('error', '8 haneli geçerli bir numara gir.');
  openThread(number);
});

let editingContactId = null;

function openContactForm(contact) {
  editingContactId = contact ? contact.id : null;
  document.getElementById('contact-form-title').textContent = contact ? 'Kişiyi Düzenle' : 'Yeni Kişi';
  document.getElementById('contact-name').value = contact ? contact.name : '';
  document.getElementById('contact-number').value = contact ? contact.number : '';
  document.getElementById('contact-number').disabled = !!contact;
  document.getElementById('contact-delete').hidden = !contact;
  switchView('contact-form');
}

document.getElementById('btn-new-contact').addEventListener('click', () => openContactForm(null));

document.getElementById('contact-save').addEventListener('click', async () => {
  const name = document.getElementById('contact-name').value.trim();
  const number = document.getElementById('contact-number').value.replace(/\D/g, '');

  let res;
  if (editingContactId) {
    res = await post('updateContact', { id: editingContactId, name });
  } else {
    if (number.length !== 8) return showToast('error', '8 haneli geçerli bir numara gir.');
    if (!name) return showToast('error', 'Bir isim gir.');
    res = await post('addContact', { name, number });
  }

  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Kaydedilemedi.');
  State.contacts = res.contacts;
  showToast('success', 'Kaydedildi.');
  switchView('contacts');
  renderContacts();
});

document.getElementById('contact-delete').addEventListener('click', async () => {
  if (!editingContactId) return;
  const res = await post('deleteContact', { id: editingContactId });
  if (!res || !res.success) return showToast('error', 'Silinemedi.');
  State.contacts = res.contacts;
  switchView('contacts');
  renderContacts();
});

/* ------------------------------------------------------------------------ */
/* APP STORE — indirilebilir ek uygulamalar (yalnızca istemci, localStorage) */
/* ------------------------------------------------------------------------ */

const APP_CATALOG = [
  { id: 'calculator', name: 'Hesap Makinesi', desc: 'Basit aritmetik hesap makinesi.', view: 'calculator', iconClass: 'icon-calculator' },
  { id: 'notes', name: 'Notlar', desc: 'Hızlı notlar al, sakla.', view: 'notes', iconClass: 'icon-notes' },
  { id: 'telegram', name: 'Telegram', desc: 'Mesajlaşma uygulaması.', view: 'telegram', iconClass: 'icon-telegram' },
  { id: 'banka', name: 'Banka', desc: 'Los Santos Bank hesabını yönet.', view: 'banka', iconClass: 'icon-banka' },
  // Lifegram artık ayrı bir resource (loe_lifegram) — React ile yazılmış
  // arayüz `lifegram` view'ındaki iframe'de açılır. Eski vanilla arayüz
  // (`social` view'ı) yerinde duruyor ama App Store'dan artık açılmıyor.
  { id: 'lifegram', name: 'Lifegram', desc: 'Fotoğraf paylaş, keşfet, mesajlaş.', view: 'lifegram', iconClass: 'icon-lifegram' },
  // Marketplace ayrı bir resource (loe_marketplace); kendi tam ekran NUI'sine
  // sahip, telefonun içine gömülü değil. `external: true` demek: switchView yerine
  // Lua'ya 'openMarketplace' gönderilip telefon kapatılır (bkz. app-grid tık işleyicisi).
  { id: 'marketplace', name: 'Marketplace', desc: 'Araç, emlak ve eşya ilanları.', external: true, iconClass: 'icon-marketplace' },
];

const INSTALL_DURATION_MS = 10000;
const INSTALL_RING_R = 15;
const INSTALL_RING_CIRC = 2 * Math.PI * INSTALL_RING_R;
const installingApps = new Map(); // id -> başlangıç zamanı (performance.now())

const InstalledApps = {
  KEY: 'loe_telephone_installed_apps',
  get() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch (e) { return []; }
  },
  has(id) { return this.get().includes(id); },
  install(id) {
    const list = this.get();
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(this.KEY, JSON.stringify(list));
    }
  },
  remove(id) {
    localStorage.setItem(this.KEY, JSON.stringify(this.get().filter((x) => x !== id)));
  },
};

function renderHomeGrid() {
  const grid = document.getElementById('app-grid');
  const storeBtn = document.getElementById('home-icon-appstore');
  grid.querySelectorAll('.installed-app').forEach((el) => el.remove());
  InstalledApps.get().forEach((id) => {
    const app = APP_CATALOG.find((a) => a.id === id);
    if (!app) return;
    const btn = document.createElement('button');
    btn.className = 'app-icon installed-app';
    btn.dataset.open = app.view || app.id;
    btn.innerHTML = `<span class="icon ${esc(app.iconClass)}"></span><label>${esc(app.name)}</label>`;
    grid.insertBefore(btn, storeBtn);
  });
  applyHomeOrder();
  [...grid.children].forEach((el) => { el.draggable = true; });
}

/* ---- ana ekran ikon sürükle-bırak sıralaması (yalnızca istemci, localStorage) ---- */

const HOME_ORDER_KEY = 'loe_telephone_home_order';

function getHomeOrder() {
  try { return JSON.parse(localStorage.getItem(HOME_ORDER_KEY) || '[]'); } catch (e) { return []; }
}

function saveHomeOrder() {
  const order = [...document.getElementById('app-grid').children].map((el) => el.dataset.open);
  localStorage.setItem(HOME_ORDER_KEY, JSON.stringify(order));
}

function applyHomeOrder() {
  const grid = document.getElementById('app-grid');
  const order = getHomeOrder();
  if (!order.length) return;
  const byId = {};
  [...grid.children].forEach((el) => { byId[el.dataset.open] = el; });
  order.forEach((id) => { if (byId[id]) grid.appendChild(byId[id]); });
}

let dragSrcEl = null;

document.getElementById('app-grid').addEventListener('dragstart', (ev) => {
  const btn = ev.target.closest('.app-icon');
  if (!btn) return;
  dragSrcEl = btn;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', btn.dataset.open || '');
  setTimeout(() => btn.classList.add('dragging'), 0);
});

document.getElementById('app-grid').addEventListener('dragover', (ev) => {
  if (!dragSrcEl) return;
  ev.preventDefault();
  const target = ev.target.closest('.app-icon');
  if (!target || target === dragSrcEl) return;
  const grid = document.getElementById('app-grid');
  const rect = target.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  grid.insertBefore(dragSrcEl, before ? target : target.nextSibling);
});

document.getElementById('app-grid').addEventListener('dragend', () => {
  if (dragSrcEl) dragSrcEl.classList.remove('dragging');
  dragSrcEl = null;
  saveHomeOrder();
});

function renderStore() {
  const list = document.getElementById('store-list');
  list.innerHTML = '';
  APP_CATALOG.forEach((app) => {
    const installed = InstalledApps.has(app.id);
    const li = document.createElement('li');
    li.className = 'list-row store-row';
    li.innerHTML = `
      <div class="store-app-icon ${esc(app.iconClass)}"></div>
      <div class="row-main">
        <div class="row-title">${esc(app.name)}</div>
        <div class="row-sub">${esc(app.desc)}</div>
      </div>
      <div class="store-action-slot"></div>
    `;
    const slot = li.querySelector('.store-action-slot');
    if (installingApps.has(app.id)) {
      renderInstallProgress(app, slot, installingApps.get(app.id));
    } else {
      slot.innerHTML = `<button class="store-action-btn ${installed ? 'open' : 'install'}" data-app="${esc(app.id)}">${installed ? 'Aç' : 'İndir'}</button>`;
    }
    list.appendChild(li);
  });
}

function renderInstallProgress(app, slot, startTime) {
  slot.innerHTML = `
    <span class="install-progress">
      <svg viewBox="0 0 36 36" class="install-ring">
        <circle cx="18" cy="18" r="${INSTALL_RING_R}" class="install-ring-bg"></circle>
        <circle cx="18" cy="18" r="${INSTALL_RING_R}" class="install-ring-fg" stroke-dasharray="${INSTALL_RING_CIRC}" stroke-dashoffset="${INSTALL_RING_CIRC}"></circle>
      </svg>
      <span class="install-progress-text">0%</span>
    </span>
  `;
  const fg = slot.querySelector('.install-ring-fg');
  const text = slot.querySelector('.install-progress-text');

  function tick() {
    if (!installingApps.has(app.id)) return clearInterval(handle); // yükleme tamamlandı/iptal oldu
    const elapsed = Date.now() - startTime;
    const pct = Math.min(100, Math.round((elapsed / INSTALL_DURATION_MS) * 100));
    fg.setAttribute('stroke-dashoffset', String(INSTALL_RING_CIRC * (1 - pct / 100)));
    text.textContent = pct + '%';
    if (elapsed >= INSTALL_DURATION_MS) {
      clearInterval(handle);
      installingApps.delete(app.id);
      InstalledApps.install(app.id);
      renderHomeGrid();
      renderStore();
      showToast('success', `${app.name} yüklendi.`);
    }
  }
  const handle = setInterval(tick, 100);
  tick();
}

let contextMenuAppId = null;

function hideAppContextMenu() {
  contextMenuAppId = null;
  document.getElementById('app-context-menu').hidden = true;
}

document.getElementById('app-grid').addEventListener('contextmenu', (ev) => {
  const btn = ev.target.closest('.installed-app');
  if (!btn) return;
  ev.preventDefault();
  const hostRect = document.getElementById('view-home').getBoundingClientRect();
  contextMenuAppId = btn.dataset.open;
  const menu = document.getElementById('app-context-menu');
  menu.style.left = (ev.clientX - hostRect.left) + 'px';
  menu.style.top = (ev.clientY - hostRect.top) + 'px';
  menu.hidden = false;
});

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#app-context-menu')) hideAppContextMenu();
});

document.getElementById('context-menu-remove').addEventListener('click', () => {
  const app = APP_CATALOG.find((a) => (a.view || a.id) === contextMenuAppId);
  if (app) {
    InstalledApps.remove(app.id);
    renderHomeGrid();
    showToast('success', `${app.name} kaldırıldı.`);
  }
  hideAppContextMenu();
});

document.getElementById('store-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-app]');
  if (!btn) return;
  const app = APP_CATALOG.find((a) => a.id === btn.dataset.app);
  if (!app) return;
  if (InstalledApps.has(app.id)) {
    if (app.external) { post('openMarketplace'); closePhoneUI(); return; }
    return switchView(app.view);
  }
  if (installingApps.has(app.id)) return;
  installingApps.set(app.id, Date.now());
  renderStore();
});

/* ------------------------------------------------------------------------ */
/* HESAP MAKİNESİ (App Store'dan indirilir)                                 */
/* ------------------------------------------------------------------------ */

const CalcState = { display: '0', prev: null, op: null, resetNext: false };

function calcRender() {
  document.getElementById('calc-display').textContent = CalcState.display;
}

function calcInputDigit(d) {
  if (CalcState.resetNext) { CalcState.display = '0'; CalcState.resetNext = false; }
  if (d === '.' && CalcState.display.includes('.')) return;
  CalcState.display = CalcState.display === '0' && d !== '.' ? d : CalcState.display + d;
  calcRender();
}

function calcClear() {
  CalcState.display = '0';
  CalcState.prev = null;
  CalcState.op = null;
  CalcState.resetNext = false;
  calcRender();
}

function calcToggleSign() {
  if (CalcState.display === '0') return;
  CalcState.display = CalcState.display.startsWith('-') ? CalcState.display.slice(1) : '-' + CalcState.display;
  calcRender();
}

function calcPercent() {
  CalcState.display = String(parseFloat(CalcState.display) / 100);
  calcRender();
}

function calcSetOp(op) {
  if (CalcState.op && !CalcState.resetNext) calcEquals();
  CalcState.prev = parseFloat(CalcState.display);
  CalcState.op = op;
  CalcState.resetNext = true;
}

function calcEquals() {
  if (CalcState.op == null || CalcState.prev == null) return;
  const cur = parseFloat(CalcState.display);
  let result = cur;
  if (CalcState.op === '+') result = CalcState.prev + cur;
  else if (CalcState.op === '-') result = CalcState.prev - cur;
  else if (CalcState.op === '*') result = CalcState.prev * cur;
  else if (CalcState.op === '/') result = cur === 0 ? 0 : CalcState.prev / cur;
  CalcState.display = String(Math.round(result * 1e8) / 1e8);
  CalcState.op = null;
  CalcState.prev = null;
  CalcState.resetNext = true;
  calcRender();
}

const CALC_KEYS = [
  { label: 'C', cls: 'calc-fn', action: calcClear },
  { label: '±', cls: 'calc-fn', action: calcToggleSign },
  { label: '%', cls: 'calc-fn', action: calcPercent },
  { label: '÷', cls: 'calc-op', action: () => calcSetOp('/') },
  { label: '7', cls: '', action: () => calcInputDigit('7') },
  { label: '8', cls: '', action: () => calcInputDigit('8') },
  { label: '9', cls: '', action: () => calcInputDigit('9') },
  { label: '×', cls: 'calc-op', action: () => calcSetOp('*') },
  { label: '4', cls: '', action: () => calcInputDigit('4') },
  { label: '5', cls: '', action: () => calcInputDigit('5') },
  { label: '6', cls: '', action: () => calcInputDigit('6') },
  { label: '−', cls: 'calc-op', action: () => calcSetOp('-') },
  { label: '1', cls: '', action: () => calcInputDigit('1') },
  { label: '2', cls: '', action: () => calcInputDigit('2') },
  { label: '3', cls: '', action: () => calcInputDigit('3') },
  { label: '+', cls: 'calc-op', action: () => calcSetOp('+') },
  { label: '0', cls: 'calc-zero', action: () => calcInputDigit('0') },
  { label: ',', cls: '', action: () => calcInputDigit('.') },
  { label: '=', cls: 'calc-eq', action: calcEquals },
];

function renderCalcGrid() {
  const grid = document.getElementById('calc-grid');
  CALC_KEYS.forEach((k) => {
    const btn = document.createElement('button');
    btn.className = `calc-btn ${k.cls}`;
    btn.textContent = k.label;
    btn.addEventListener('click', k.action);
    grid.appendChild(btn);
  });
}
renderCalcGrid();

/* ------------------------------------------------------------------------ */
/* NOTLAR (App Store'dan indirilir) — yalnızca istemci, localStorage        */
/* ------------------------------------------------------------------------ */

const NotesDB = {
  KEY: 'loe_telephone_notes',
  list() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch (e) { return []; }
  },
  save(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); },
  create() {
    const list = this.list();
    const note = { id: Date.now(), text: '', ts: Date.now() };
    list.unshift(note);
    this.save(list);
    return note;
  },
  update(id, text) {
    const list = this.list();
    const note = list.find((n) => n.id === id);
    if (note) { note.text = text; note.ts = Date.now(); this.save(list); }
  },
  remove(id) {
    this.save(this.list().filter((n) => n.id !== id));
  },
};

let currentNoteId = null;

function renderNotes() {
  const list = document.getElementById('notes-list');
  const empty = document.getElementById('notes-empty');
  list.innerHTML = '';
  const notes = NotesDB.list();
  empty.hidden = notes.length > 0;
  notes.forEach((n) => {
    const firstLine = n.text.split('\n')[0].trim();
    const rest = n.text.split('\n').slice(1).join(' ').trim();
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="row-main">
        <div class="row-title">${esc(firstLine || 'Yeni Not')}</div>
        <div class="row-sub">${esc(rest)}</div>
      </div>
      <div class="row-meta">${esc(fmtRelative(Math.floor(n.ts / 1000)))}</div>
    `;
    li.addEventListener('click', () => openNote(n.id));
    list.appendChild(li);
  });
}

function openNote(id) {
  const note = NotesDB.list().find((n) => n.id === id);
  if (!note) return;
  currentNoteId = id;
  document.getElementById('note-text-input').value = note.text;
  switchView('note-edit');
}

document.getElementById('btn-new-note').addEventListener('click', () => {
  const note = NotesDB.create();
  currentNoteId = note.id;
  document.getElementById('note-text-input').value = '';
  switchView('note-edit');
});

document.getElementById('note-text-input').addEventListener('input', (ev) => {
  if (currentNoteId == null) return;
  NotesDB.update(currentNoteId, ev.target.value);
});

document.getElementById('note-delete').addEventListener('click', () => {
  if (currentNoteId == null) return;
  NotesDB.remove(currentNoteId);
  currentNoteId = null;
  switchView('notes');
});

document.getElementById('note-back').addEventListener('click', () => {
  if (currentNoteId != null) {
    const note = NotesDB.list().find((n) => n.id === currentNoteId);
    if (note && !note.text.trim()) NotesDB.remove(currentNoteId);
  }
  currentNoteId = null;
  switchView('notes');
});

/* ------------------------------------------------------------------------ */
/* TELEGRAM (App Store'dan indirilir) — genel/özel grup, arama, davet kodu  */
/* ------------------------------------------------------------------------ */

let telegramNewType = 'public';
let currentGroupId = null;

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* yoksay */ }
  document.body.removeChild(ta);
}

function renderTelegramGroups(groups) {
  const list = document.getElementById('telegram-groups-list');
  const empty = document.getElementById('telegram-groups-empty');
  list.innerHTML = '';
  empty.hidden = groups.length > 0;
  groups.forEach((g) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(g.name))}</div>
      <div class="row-main">
        <div class="row-title">${esc(g.name)}${g.type === 'private' ? ' 🔒' : ''}</div>
        <div class="row-sub">${esc(g.lastBody || 'Henüz mesaj yok')}</div>
      </div>
      <div class="row-meta">${g.lastAt ? esc(fmtRelative(g.lastAt)) : ''}</div>
    `;
    li.addEventListener('click', () => openGroup(g.id, g.name, g.inviteCode));
    list.appendChild(li);
  });
}

async function loadTelegramGroups() {
  const res = await post('getMyGroups');
  renderTelegramGroups(res && res.success ? res.groups : []);
}

document.getElementById('btn-telegram-new').addEventListener('click', () => {
  document.getElementById('telegram-new-name').value = '';
  telegramNewType = 'public';
  document.querySelectorAll('#telegram-new-type .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.groupType === 'public'));
  switchView('telegram-new');
});

document.querySelectorAll('#telegram-new-type .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    telegramNewType = btn.dataset.groupType;
    document.querySelectorAll('#telegram-new-type .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('telegram-new-create').addEventListener('click', async () => {
  const name = document.getElementById('telegram-new-name').value.trim();
  if (!name) return showToast('error', 'Bir grup adı gir.');
  const res = await post('createGroup', { name, type: telegramNewType });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Grup oluşturulamadı.');
  showToast('success', 'Grup oluşturuldu.');
  openGroup(res.group.id, res.group.name, res.group.inviteCode);
});

document.getElementById('btn-telegram-search').addEventListener('click', () => {
  document.getElementById('telegram-search-input').value = '';
  document.getElementById('telegram-invite-input').value = '';
  switchView('telegram-search');
  loadTelegramSearch('');
});

async function loadTelegramSearch(query) {
  const res = await post('searchGroups', { query });
  const list = document.getElementById('telegram-search-list');
  const empty = document.getElementById('telegram-search-empty');
  list.innerHTML = '';
  if (!res || !res.success) { empty.hidden = false; return; }
  empty.hidden = res.groups.length > 0;
  res.groups.forEach((g) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(g.name))}</div>
      <div class="row-main">
        <div class="row-title">${esc(g.name)}</div>
        <div class="row-sub">${esc(g.memberCount)} üye</div>
      </div>
      <button class="store-action-btn ${g.isMember ? 'open' : 'install'}" data-join-group="${esc(g.id)}">${g.isMember ? 'Aç' : 'Katıl'}</button>
    `;
    list.appendChild(li);
  });
}

document.getElementById('telegram-search-input').addEventListener('input', (ev) => {
  loadTelegramSearch(ev.target.value.trim());
});

document.getElementById('telegram-search-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-join-group]');
  if (!btn) return;
  const groupId = btn.dataset.joinGroup;
  if (btn.textContent === 'Aç') {
    const res = await post('getMyGroups');
    const g = res && res.success && res.groups.find((x) => String(x.id) === String(groupId));
    if (g) openGroup(g.id, g.name, g.inviteCode);
    return;
  }
  const res = await post('joinGroupById', { groupId });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Katılınamadı.');
  showToast('success', `${res.group.name} grubuna katıldın.`);
  openGroup(res.group.id, res.group.name, res.group.inviteCode);
});

document.getElementById('telegram-invite-join').addEventListener('click', async () => {
  const code = document.getElementById('telegram-invite-input').value.trim();
  if (!code) return showToast('error', 'Bir davet kodu gir.');
  const res = await post('joinGroupByInvite', { code });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Katılınamadı.');
  showToast('success', `${res.group.name} grubuna katıldın.`);
  openGroup(res.group.id, res.group.name, res.group.inviteCode);
});

async function openGroup(id, name, inviteCode) {
  currentGroupId = id;
  document.getElementById('telegram-group-title').textContent = name;
  document.getElementById('telegram-group-invite-code').textContent = inviteCode;
  document.getElementById('telegram-group-messages').innerHTML = '';
  switchView('telegram-group');
  const res = await post('getGroupMessages', { groupId: id });
  renderGroupMessages(res);
}

function appendGroupBubble(fromNumber, body, myNumber) {
  const box = document.getElementById('telegram-group-messages');
  const out = fromNumber === myNumber;
  const b = document.createElement('div');
  b.className = `bubble ${out ? 'out' : 'in'}`;
  if (!out) {
    const who = document.createElement('div');
    who.className = 'bubble-sender';
    who.textContent = contactNameFor(fromNumber) || fmtNumber(fromNumber);
    b.appendChild(who);
  }
  const text = document.createElement('div');
  text.textContent = body;
  b.appendChild(text);
  box.appendChild(b);
  box.scrollTop = box.scrollHeight;
}

function renderGroupMessages(res) {
  const box = document.getElementById('telegram-group-messages');
  box.innerHTML = '';
  if (!res || !res.success) return;
  [...res.messages].reverse().forEach((m) => appendGroupBubble(m.from_number, m.body, res.myNumber));
}

async function sendGroupMessage() {
  const input = document.getElementById('telegram-group-input');
  const body = input.value.trim();
  if (!body || currentGroupId == null) return;
  const res = await post('sendGroupMessage', { groupId: currentGroupId, body });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Mesaj gönderilemedi.');
  input.value = '';
  appendGroupBubble(res.message.from_number, body, res.message.from_number);
}

document.getElementById('telegram-group-send').addEventListener('click', sendGroupMessage);
document.getElementById('telegram-group-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') sendGroupMessage();
});

document.getElementById('telegram-group-invite-copy').addEventListener('click', () => {
  const code = document.getElementById('telegram-group-invite-code').textContent;
  const btn = document.getElementById('telegram-group-invite-copy');
  copyToClipboard(code).then(() => {
    btn.textContent = 'Kopyalandı';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Kopyala'; btn.classList.remove('copied'); }, 1500);
  });
});

/* ------------------------------------------------------------------------ */
/* HATLARIM — hat değiştir (ana ekrandaki Ayarlar ikonundan açılır)         */
/* ------------------------------------------------------------------------ */

function renderSettingsLines() {
  const list = document.getElementById('lines-list');
  const empty = document.getElementById('lines-empty');
  if (!list) return;
  list.innerHTML = '';
  empty.hidden = State.numbers.length > 0;
  document.getElementById('max-lines').textContent = State.maxLines;

  State.numbers.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'list-row line-row';
    li.innerHTML = `
      <div class="avatar">
        <svg viewBox="0 0 18 12" width="16" height="11"><rect x="0" y="7" width="3" height="5" rx="0.5" fill="#04262c"/><rect x="5" y="5" width="3" height="7" rx="0.5" fill="#04262c"/><rect x="10" y="3" width="3" height="9" rx="0.5" fill="#04262c"/><rect x="15" y="0" width="3" height="12" rx="0.5" fill="#04262c"/></svg>
      </div>
      <div class="row-main">
        <div class="row-title">${esc(fmtNumber(n.number))} ${n.active ? '<span class="active-tag">AKTİF</span>' : ''}</div>
      </div>
    `;
    if (!n.active) {
      li.addEventListener('click', async () => {
        const res = await post('setActiveLine', n.number);
        applyState(res);
        showToast('success', `Aktif hat: ${fmtNumber(n.number)}`);
      });
    }
    list.appendChild(li);
  });
}

/* ------------------------------------------------------------------------ */
/* KAMERA — GTA Online tarzı TAM EKRAN                                       */
/*   Telefon gizlenir, script kamera tüm ekranı kaplar; burada yalnızca      */
/*   #camera-overlay'deki kadraj/oran maskesi yönetilir. NUI odağı kapalı:   */
/*   tuşlar client/main.lua'da okunur, buraya cameraInput olarak gelir.      */
/*   Çekim ekran oranındadır; ortalanmış kadraj merkezden kırpılır, yani     */
/*   ekranda görülen kare ile kaydedilen kare birebir aynıdır.               */
/* ------------------------------------------------------------------------ */

const cameraOverlay = document.getElementById('camera-overlay');

/** null = kırpma yok (tam ekran). */
function cameraRatioKey() {
  if (State.cameraMode === 'story') return '9:16';
  if (State.cameraMode === 'post') return State.cameraPostRatio;
  return null;
}

function layoutCameraWindow() {
  const win = document.getElementById('camera-window');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const key = cameraRatioKey();
  const ratio = key ? CAMERA_RATIOS[key] : W / H;
  let w = W;
  let h = W / ratio;
  if (h > H) { h = H; w = H * ratio; }
  win.style.width = `${w}px`;
  win.style.height = `${h}px`;
  win.style.left = `${(W - w) / 2}px`;
  win.style.top = `${(H - h) / 2}px`;
}

function renderCameraOverlay() {
  const key = cameraRatioKey();
  const isVideo = State.cameraMedia === 'video';
  const recording = VideoRec.recording;

  document.getElementById('camera-ratio-label').textContent = key || 'TAM EKRAN';
  document.getElementById('camera-flash').classList.toggle('active', CCState.flash);
  document.querySelectorAll('#camera-media .cam-mode').forEach((el) => {
    el.classList.toggle('active', el.dataset.media === State.cameraMedia);
  });
  document.querySelectorAll('#camera-modes .cam-mode').forEach((el) => {
    el.classList.toggle('active', el.dataset.mode === State.cameraMode);
  });
  // Kayıt sürerken tuval boyutu sabit kalmalı: medya/ölçek değişimi kilitli.
  document.getElementById('camera-media').classList.toggle('locked', VideoRec.busy);
  document.getElementById('camera-modes').classList.toggle('locked', VideoRec.busy);

  const isPost = State.cameraMode === 'post';
  const ratios = document.getElementById('camera-ratios');
  ratios.hidden = !isPost;
  ratios.querySelectorAll('.cam-ratio').forEach((el) => {
    el.classList.toggle('active', el.dataset.ratio === State.cameraPostRatio);
  });
  document.getElementById('camera-key-ratio').hidden = !isPost;
  document.getElementById('camera-key-shoot').textContent = !isVideo ? 'Çek' : (recording ? 'Durdur' : 'Kaydet');
  document.getElementById('camera-dest').textContent = isVideo
    ? `Galeriye kaydedilir · en fazla ${VIDEO_MAX_MS / 1000} sn`
    : 'Galeriye kaydedilir';

  document.getElementById('camera-window').classList.toggle('recording', recording);
  document.getElementById('camera-rec').hidden = !recording;
  if (recording) renderRecTimer();
  layoutCameraWindow();
}

window.addEventListener('resize', () => { if (State.cameraOpen && !VideoRec.busy) layoutCameraWindow(); });

let cameraSavedTimer = null;

function hideCameraOverlay() {
  if (VideoRec.recording) stopVideoRecording(); // çıkarken kayıt yarım kalmasın, kaydedilsin
  cameraOverlay.hidden = true;
  document.getElementById('camera-saved').hidden = true;
  document.body.classList.remove('camera-mode');
}

/**
 * Oyun görüntüsünü DOĞRUDAN bu sayfada yakalar (FiveM game-view dokusu, bkz
 * screencapture'ın aynı tekniği). screencapture'ın kendisi kullanılmıyor:
 * kareyi görünmez kendi çerçevesinde requestAnimationFrame ile bekliyordu ve
 * Chromium o çerçevede kareleri durdurduğu için her fotoğraf ancak bir sonraki
 * çekim isteğinde teslim ediliyordu. Doku yalnızca oyunu içerir — NUI (kadraj,
 * yazılar, telefon) fotoğrafa girmez. Kırpma tek GPU geçişinde, doku
 * koordinatlarıyla yapılır (kadraj ortalı olduğu için yön/ters çevirme önemsiz).
 */
const GameView = (() => {
  const VERT = `
    attribute vec2 a_position;
    attribute vec2 a_texcoord;
    uniform vec2 u_scale;
    uniform vec2 u_offset;
    varying vec2 textureCoordinate;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      textureCoordinate = a_texcoord * u_scale + u_offset;
    }`;
  const FRAG = `
    varying highp vec2 textureCoordinate;
    uniform sampler2D external_texture;
    void main() {
      gl_FragColor = texture2D(external_texture, textureCoordinate);
    }`;
  const PHOTO_MAX_EDGE = 1920;
  const VIDEO_MAX_EDGE = 1280; // 20 sn kayıtta kodlama yükü/dosya boyutu makul kalsın

  let canvas = null;
  let gl = null;
  let uScale = null;
  let uOffset = null;
  let streamTimer = null;

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  }

  function init() {
    if (gl) return true;
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext('webgl', {
      antialias: false, depth: false, stencil: false, alpha: false,
      desynchronized: true, failIfMajorPerformanceCaveat: false,
    });
    if (!gl) return false;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // FiveM game-view kancası: bu TAM sıra, dokuyu oyunun görüntüsüne bağlar.
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'external_texture'), 0);
    uScale = gl.getUniformLocation(program, 'u_scale');
    uOffset = gl.getUniformLocation(program, 'u_offset');

    const attribute = (name, data) => {
      const loc = gl.getAttribLocation(program, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc);
    };
    attribute('a_position', [-1, -1, 1, -1, -1, 1, 1, 1]);
    attribute('a_texcoord', [0, 0, 1, 0, 0, 1, 1, 1]);
    return true;
  }

  /** Tuvali ortalanmış kadraja göre boyutlar (ratio = genişlik/yükseklik; null = tam ekran). */
  function configure(ratio, maxEdge) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let cw = W;
    let ch = H;
    if (ratio) {
      if (W / H > ratio) cw = H * ratio;
      else ch = W / ratio;
    }
    const scale = Math.min(1, maxEdge / Math.max(cw, ch));
    // Video kodlayıcıları çift piksel boyutu ister.
    canvas.width = Math.max(2, Math.round((cw * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((ch * scale) / 2) * 2);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uScale, cw / W, ch / H);
    gl.uniform2f(uOffset, (1 - cw / W) / 2, (1 - ch / H) / 2);
  }

  function release() {
    canvas.width = 1;
    canvas.height = 1;
  }

  /** Tek kare: JPEG data URL döner (video akışı sürerken null). */
  function capture(ratio) {
    if (streamTimer || !init()) return null;
    configure(ratio, PHOTO_MAX_EDGE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92); // aynı görevde: çizim tamponu henüz silinmedi
    release();
    return dataUrl;
  }

  /**
   * Canlı akış: tuvale sürekli oyun görüntüsü çizer, { stream, poster } döner.
   * Çizim zamanlayıcıyla yapılır (requestAnimationFrame değil) — kare döngüsü
   * yavaşlasa bile kayıt kare almaya devam eder.
   */
  function startStream(ratio, fps) {
    if (streamTimer || !init() || typeof canvas.captureStream !== 'function') return null;
    configure(ratio, VIDEO_MAX_EDGE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const poster = canvas.toDataURL('image/jpeg', 0.85);
    const stream = canvas.captureStream(fps);
    streamTimer = setInterval(() => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4), 1000 / fps);
    return { stream, poster };
  }

  function stopStream() {
    if (!streamTimer) return;
    clearInterval(streamTimer);
    streamTimer = null;
    release();
  }

  return { init, capture, startStream, stopStream };
})();

/* ---- Video kaydı (20 sn) — MediaRecorder ile WebM, sesiz ------------------ */

const VIDEO_MAX_MS = 20000;
const VIDEO_FPS = 30;
const VIDEO_BITRATE = 1000000;
const VIDEO_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

/** recording: kamera kaydediyor · busy: kaydediyor VEYA kayıt galeriye yazılıyor. */
const VideoRec = { recording: false, busy: false, startedAt: 0, stop: null, autoStopTimer: null, tickTimer: null };

function fmtRecTime(ms) {
  const s = Math.floor(ms / 1000);
  return `00:${String(Math.min(s, 99)).padStart(2, '0')}`;
}

function renderRecTimer() {
  const elapsed = Math.min(VIDEO_MAX_MS, performance.now() - VideoRec.startedAt);
  document.getElementById('camera-rec').textContent = `● ${fmtRecTime(elapsed)} / ${fmtRecTime(VIDEO_MAX_MS)}`;
}

/** Kayıt sonucu bildirimi: kameradaysak rozet, telefona dönüldüyse toast. */
function notifyCameraResult(poster, text, ok) {
  if (State.cameraOpen) showCameraSaved(poster, text);
  else showToast(ok ? 'success' : 'error', `${text}.`);
}

function startVideoRecording() {
  if (VideoRec.busy || !State.cameraOpen) return;

  const key = cameraRatioKey();
  const mimeType = window.MediaRecorder ? VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) : null;
  const live = mimeType ? GameView.startStream(key ? CAMERA_RATIOS[key] : null, VIDEO_FPS) : null;
  if (!live) {
    showCameraSaved(null, 'Video kaydı bu istemcide desteklenmiyor');
    return;
  }

  let recorder;
  try {
    recorder = new MediaRecorder(live.stream, { mimeType, videoBitsPerSecond: VIDEO_BITRATE });
  } catch (err) {
    console.error('[loe_telephone] video kaydı başlatılamadı:', err);
    live.stream.getTracks().forEach((t) => t.stop());
    GameView.stopStream();
    showCameraSaved(null, 'Video kaydı başlatılamadı');
    return;
  }

  const chunks = [];
  const startedAt = performance.now();
  let endedAt = startedAt;

  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  recorder.onstop = async () => {
    live.stream.getTracks().forEach((t) => t.stop());
    GameView.stopStream();
    try {
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (!blob.size) throw new Error('boş kayıt');
      await GalleryDB.addVideo(blob, live.poster, Math.round(endedAt - startedAt));
      notifyCameraResult(live.poster, 'Video galeriye kaydedildi', true);
    } catch (err) {
      console.error('[loe_telephone] video kaydedilemedi:', err);
      notifyCameraResult(null, 'Video kaydedilemedi', false);
    } finally {
      VideoRec.busy = false;
      if (State.cameraOpen) renderCameraOverlay();
    }
  };

  VideoRec.recording = true;
  VideoRec.busy = true;
  VideoRec.startedAt = startedAt;
  VideoRec.stop = () => {
    endedAt = performance.now();
    recorder.stop();
  };
  VideoRec.autoStopTimer = setTimeout(stopVideoRecording, VIDEO_MAX_MS);
  VideoRec.tickTimer = setInterval(renderRecTimer, 250);
  recorder.start(1000);
  post('cameraRecording', { active: true });
  renderCameraOverlay();
}

function stopVideoRecording() {
  if (!VideoRec.recording) return;
  VideoRec.recording = false;
  clearTimeout(VideoRec.autoStopTimer);
  clearInterval(VideoRec.tickTimer);
  VideoRec.stop();
  VideoRec.stop = null;
  post('cameraRecording', { active: false });
  if (State.cameraOpen) renderCameraOverlay();
}

/** Bir sonraki kare (kare gelmezse 100 ms sonra yine devam — asla takılmaz). */
function nextFrame() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}

/** Kamerada kısa süreli "kaydedildi" rozeti (küçük önizleme + yazı). */
function showCameraSaved(dataUrl, text) {
  const box = document.getElementById('camera-saved');
  const thumb = document.getElementById('camera-saved-thumb');
  thumb.hidden = !dataUrl;
  if (dataUrl) thumb.src = dataUrl;
  document.getElementById('camera-saved-text').textContent = text;
  box.hidden = false;
  clearTimeout(cameraSavedTimer);
  cameraSavedTimer = setTimeout(() => { box.hidden = true; }, 2500);
}

async function openCamera() {
  State.cameraOpen = true;
  document.getElementById('camera-selfie').hidden = true;
  document.getElementById('camera-saved').hidden = true;
  document.body.classList.add('camera-mode');
  cameraOverlay.hidden = false;
  renderCameraOverlay();
  GameView.init(); // doku kancası çekimden önce hazır olsun

  const res = await post('openCamera', { flash: CCState.flash });
  if (!res || !res.success) {
    if (State.cameraOpen) {
      State.cameraOpen = false;
      hideCameraOverlay();
      switchView(State.cameraReturnView || 'home');
    }
    showToast('error', 'Kamera açılamadı.');
  }
}

async function closeCamera() {
  if (!State.cameraOpen) return;
  State.cameraOpen = false;
  hideCameraOverlay();
  await post('closeCamera');
}

document.getElementById('btn-new-photo').addEventListener('click', () => {
  State.cameraReturnView = 'gallery';
  State.cameraMedia = 'photo';
  State.cameraMode = 'full';
  switchView('camera');
});

/** Lua'dan gelen tuş: Q fotoğraf/video, ←/→ ölçek, R gönderi oranı.
 *  Kayıt sürerken (ve kayıt yazılırken) tuval boyutu sabit kalmalı: yok sayılır. */
function handleCameraInput(input) {
  if (VideoRec.busy) return;
  if (input === 'media') {
    State.cameraMedia = State.cameraMedia === 'photo' ? 'video' : 'photo';
  } else if (input === 'modePrev' || input === 'modeNext') {
    const step = input === 'modeNext' ? 1 : -1;
    const i = CAMERA_MODES.indexOf(State.cameraMode);
    State.cameraMode = CAMERA_MODES[(i + step + CAMERA_MODES.length) % CAMERA_MODES.length];
  } else if (input === 'ratio' && State.cameraMode === 'post') {
    const i = CAMERA_POST_RATIOS.indexOf(State.cameraPostRatio);
    State.cameraPostRatio = CAMERA_POST_RATIOS[(i + 1) % CAMERA_POST_RATIOS.length];
  }
  renderCameraOverlay();
}

let cameraCapturing = false;

/** Fotoğraf deklanşörü: kareyi seçili ölçekte yakala ve galeriye kaydet.
 *  GTA Online'daki gibi kamerada kalınır (arka arkaya çekim). */
async function takeCameraPhoto(flash) {
  if (cameraCapturing || VideoRec.busy || !State.cameraOpen) return;
  cameraCapturing = true;
  const key = cameraRatioKey();
  try {
    // Flaşta Lua'nın yaktığı ışığın sahneye yansıması için birkaç kare bekle.
    for (let i = 0; i < (flash ? 3 : 1); i += 1) await nextFrame();
    const dataUrl = GameView.capture(key ? CAMERA_RATIOS[key] : null);
    if (!dataUrl) throw new Error('WebGL game-view kullanılamıyor');
    await GalleryDB.add(dataUrl);
    notifyCameraResult(dataUrl, 'Galeriye kaydedildi', true);
  } catch (err) {
    console.error('[loe_telephone] fotoğraf çekilemedi:', err);
    showCameraSaved(null, 'Fotoğraf çekilemedi');
  } finally {
    cameraCapturing = false;
  }
}

/* ------------------------------------------------------------------------ */
/* GALERİ — yerel (IndexedDB), SUNUCUYA YÜKLENMEZ                           */
/* ------------------------------------------------------------------------ */

// Kamera ham JPEG'i tam çözünürlükte (1-3 MB) üretebiliyor.
// Bu veri Lifegram paylaşımında sunucuya lib.callback (network event) ile
// gidiyor ve FiveM'in olay başına ~1 MB sınırı var — sıkıştırılmadan yollanırsa
// "payload is too large" script hatasıyla sessizce başarısız oluyor. Galeriye
// giren HER fotoğrafı (çekilen + paylaşılan) burada tek noktadan küçültüyoruz,
// böylece post/hikaye/avatar/airshare gibi tüm tüketiciler otomatik güvende.
function compressDataUrl(dataUrl, maxDim = 1024, quality = 0.72) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const GalleryDB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('loe_telephone_gallery', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function add(dataUrl) {
    const db = await open();
    const stored = await compressDataUrl(dataUrl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      const req = tx.objectStore('photos').add({ dataUrl: stored, caption: '', ts: Date.now() });
      req.onsuccess = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Video: dosya Blob olarak saklanır; `dataUrl` kapak karesidir (galeri ızgarası için). */
  async function addVideo(blob, posterDataUrl, duration) {
    const db = await open();
    const poster = await compressDataUrl(posterDataUrl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      const req = tx.objectStore('photos').add({
        kind: 'video', blob, duration, dataUrl: poster, caption: '', ts: Date.now(),
      });
      req.onsuccess = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Fotoğraf + video, en yeni önce. */
  async function list() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').getAll();
      req.onsuccess = () => resolve(req.result.reverse());
      req.onerror = () => reject(req.error);
    });
  }

  /** Yalnızca fotoğraflar — SMS/AirShare/Lifegram gibi fotoğraf seçicileri için. */
  async function listPhotos() {
    return (await list()).filter((item) => item.kind !== 'video');
  }

  async function get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function setCaption(id, caption) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      const store = tx.objectStore('photos');
      const req = store.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return resolve(false);
        row.caption = caption;
        store.put(row);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  return { add, addVideo, list, listPhotos, get, setCaption, remove };
})();

function fmtVideoDuration(ms) {
  const s = Math.max(1, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  grid.innerHTML = '';

  let items = [];
  try { items = await GalleryDB.list(); } catch (e) { /* tarayıcı desteklemiyor olabilir */ }

  empty.hidden = items.length > 0;
  items.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${p.dataUrl}" alt="" />`
      + (p.kind === 'video' ? `<span class="vid">▶ ${fmtVideoDuration(p.duration)}</span>` : '')
      + (p.caption ? `<span class="cap">${esc(p.caption)}</span>` : '');
    div.addEventListener('click', () => openPhoto(p.id));
    grid.appendChild(div);
  });
}

let videoPreviewUrl = null;

/** Galeri detayındaki video oynatıcıyı durdurur ve Blob URL'ini bırakır. */
function releaseVideoPreview() {
  if (!videoPreviewUrl) return;
  const video = document.getElementById('photo-view-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(videoPreviewUrl);
  videoPreviewUrl = null;
}

async function openPhoto(id) {
  const item = await GalleryDB.get(id);
  if (!item) return;
  State.currentPhotoId = id;
  releaseVideoPreview();

  const isVideo = item.kind === 'video';
  const img = document.getElementById('photo-view-image');
  const video = document.getElementById('photo-view-video');
  img.hidden = isVideo;
  video.hidden = !isVideo;
  document.getElementById('photo-view-title').textContent = isVideo ? 'Video' : 'Fotoğraf';

  if (isVideo) {
    videoPreviewUrl = URL.createObjectURL(item.blob);
    video.poster = item.dataUrl;
    video.src = videoPreviewUrl;
    video.play().catch(() => { /* kullanıcı oynat'a basar */ });
  } else {
    img.src = item.dataUrl;
  }
  document.getElementById('photo-caption-input').value = item.caption || '';
  switchView('photo');
}

// MediaRecorder WebM'e süre yazmaz (duration = Infinity) ve ilerleme çubuğu
// çalışmaz; sona atlayıp geri dönmek tarayıcıyı süreyi hesaplamaya zorlar.
document.getElementById('photo-view-video').addEventListener('loadedmetadata', (ev) => {
  const video = ev.target;
  if (video.duration !== Infinity) return;
  video.currentTime = 1e101;
  video.addEventListener('timeupdate', function rewind() {
    video.removeEventListener('timeupdate', rewind);
    video.currentTime = 0;
  });
});

document.getElementById('photo-caption-input').addEventListener('change', async (ev) => {
  if (State.currentPhotoId == null) return;
  await GalleryDB.setCaption(State.currentPhotoId, ev.target.value.trim());
});

document.getElementById('photo-delete').addEventListener('click', async () => {
  if (State.currentPhotoId == null) return;
  releaseVideoPreview();
  await GalleryDB.remove(State.currentPhotoId);
  State.currentPhotoId = null;
  switchView('gallery');
});

/* ------------------------------------------------------------------------ */
/* KONTROL MERKEZİ (durum çubuğu simgelerinden açılır)                      */
/* ------------------------------------------------------------------------ */

const CCState = { brightness: 100, ringVolume: 70, silent: false, flash: false };

function loadCCState() {
  try {
    Object.assign(CCState, JSON.parse(localStorage.getItem('loe_telephone_cc_state') || '{}'));
  } catch (e) { /* varsayılanlar kalır */ }
}

function saveCCState() {
  localStorage.setItem('loe_telephone_cc_state', JSON.stringify(CCState));
}

function applyBrightness() {
  frame.style.filter = `brightness(${Math.max(30, CCState.brightness)}%)`;
}

function renderCCUI() {
  document.getElementById('cc-brightness-fill').style.height = CCState.brightness + '%';
  document.getElementById('cc-volume-fill').style.height = CCState.ringVolume + '%';
  document.getElementById('cc-silent').classList.toggle('active', CCState.silent);
  document.getElementById('cc-flash').classList.toggle('active', CCState.flash);
  document.getElementById('camera-flash').classList.toggle('active', CCState.flash);
  applyBrightness();
}

loadCCState();

function openControlCenter() {
  renderCCUI();
  document.getElementById('control-center').classList.add('open');
}
function closeControlCenter() {
  document.getElementById('control-center').classList.remove('open');
}

document.getElementById('btn-control-center').addEventListener('click', (ev) => {
  ev.stopPropagation();
  openControlCenter();
});
document.getElementById('cc-backdrop').addEventListener('click', closeControlCenter);

document.getElementById('cc-silent').addEventListener('click', () => {
  CCState.silent = !CCState.silent;
  saveCCState();
  renderCCUI();
});
document.getElementById('cc-flash').addEventListener('click', () => {
  CCState.flash = !CCState.flash;
  saveCCState();
  renderCCUI();
});

function bindVSlider(el, onChange) {
  function pctFromEvent(ev) {
    const rect = el.getBoundingClientRect();
    const pct = 100 - ((ev.clientY - rect.top) / rect.height) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }
  let dragging = false;
  el.addEventListener('mousedown', (ev) => { dragging = true; onChange(pctFromEvent(ev)); });
  document.addEventListener('mousemove', (ev) => { if (dragging) onChange(pctFromEvent(ev)); });
  document.addEventListener('mouseup', () => { dragging = false; });
}

bindVSlider(document.getElementById('cc-brightness-slider'), (pct) => {
  CCState.brightness = pct;
  document.getElementById('cc-brightness-fill').style.height = pct + '%';
  applyBrightness();
  saveCCState();
});
bindVSlider(document.getElementById('cc-volume-slider'), (pct) => {
  CCState.ringVolume = pct;
  document.getElementById('cc-volume-fill').style.height = pct + '%';
  saveCCState();
});

/* ---- zil sesi (Web Audio API ile üretilir — harici ses dosyası YOK) ---- */

let ringtoneCtx = null;
let ringtoneInterval = null;

function playRingtoneBeep() {
  if (CCState.silent || CCState.ringVolume <= 0) return;
  if (!ringtoneCtx) ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = ringtoneCtx;
  const now = ctx.currentTime;
  [0, 0.18].forEach((offset) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = (CCState.ringVolume / 100) * 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.14);
  });
}

function startRingtone() {
  stopRingtone();
  playRingtoneBeep();
  ringtoneInterval = setInterval(playRingtoneBeep, 900);
}

function stopRingtone() {
  if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
}

function triggerFlashPulse() {
  const el = document.getElementById('flash-pulse');
  el.classList.remove('firing');
  void el.offsetWidth;
  el.classList.add('firing');
}

/* ------------------------------------------------------------------------ */
/* AIRSHARE (Kontrol Merkezi) — yakındaki oyuncuya numara/fotoğraf paylaşımı */
/* ------------------------------------------------------------------------ */

let airshareKind = null;
let airsharePhotoDataUrl = null;
let currentIncomingShareId = null;

function openSheet(id) { document.getElementById(id).classList.add('open'); }
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }

document.getElementById('cc-airshare').addEventListener('click', () => {
  closeControlCenter();
  openSheet('airshare-sheet');
});
document.getElementById('airshare-backdrop').addEventListener('click', () => closeSheet('airshare-sheet'));
document.getElementById('airshare-photo-backdrop').addEventListener('click', () => closeSheet('airshare-photo-sheet'));
document.getElementById('airshare-nearby-backdrop').addEventListener('click', () => closeSheet('airshare-nearby-sheet'));

document.getElementById('airshare-share-number').addEventListener('click', () => {
  airshareKind = 'number';
  airsharePhotoDataUrl = null;
  closeSheet('airshare-sheet');
  openNearbyForShare();
});

document.getElementById('airshare-share-photo').addEventListener('click', async () => {
  closeSheet('airshare-sheet');
  const grid = document.getElementById('airshare-photo-grid');
  const empty = document.getElementById('airshare-photo-empty');
  grid.innerHTML = '';
  let photos = [];
  try { photos = await GalleryDB.listPhotos(); } catch (e) { /* tarayıcı desteklemiyor olabilir */ }
  empty.hidden = photos.length > 0;
  photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${p.dataUrl}" alt="" />`;
    div.addEventListener('click', () => {
      airshareKind = 'photo';
      airsharePhotoDataUrl = p.dataUrl;
      closeSheet('airshare-photo-sheet');
      openNearbyForShare();
    });
    grid.appendChild(div);
  });
  openSheet('airshare-photo-sheet');
});

async function openNearbyForShare() {
  const list = document.getElementById('airshare-nearby-list');
  const empty = document.getElementById('airshare-nearby-empty');
  list.innerHTML = '';
  const res = await post('getNearbyPlayers');
  const players = (res && res.success) ? res.players : [];
  empty.hidden = players.length > 0;
  players.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar">${esc(initials(p.name))}</div>
      <div class="row-main">
        <div class="row-title">${esc(p.name)}</div>
        <div class="row-sub">${p.distance.toFixed(1)} m</div>
      </div>
    `;
    li.addEventListener('click', () => sendShareRequest(p.serverId, p.name));
    list.appendChild(li);
  });
  openSheet('airshare-nearby-sheet');
}

async function sendShareRequest(targetServerId, targetName) {
  const payload = { targetServerId, kind: airshareKind };
  if (airshareKind === 'photo') payload.dataUrl = await compressDataUrl(airsharePhotoDataUrl);
  const res = await post('shareRequest', payload);
  closeSheet('airshare-nearby-sheet');
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'İstek gönderilemedi.');
  showToast('success', `İstek gönderildi: ${targetName} (onay bekleniyor).`);
}

document.getElementById('airshare-accept').addEventListener('click', async () => {
  if (!currentIncomingShareId) return;
  const requestId = currentIncomingShareId;
  currentIncomingShareId = null;
  document.getElementById('airshare-incoming').hidden = true;
  await post('shareRespond', { requestId, accept: true });
});

document.getElementById('airshare-decline').addEventListener('click', async () => {
  if (!currentIncomingShareId) return;
  const requestId = currentIncomingShareId;
  currentIncomingShareId = null;
  document.getElementById('airshare-incoming').hidden = true;
  await post('shareRespond', { requestId, accept: false });
});

/* ------------------------------------------------------------------------ */
/* ARAMA — gelen / aktif ekranlar                                           */
/* ------------------------------------------------------------------------ */

function showIncomingCallScreen(call) {
  State.activeCallId = call.callId;
  document.getElementById('incoming-number').textContent = contactNameFor(call.fromNumber) || fmtNumber(call.fromNumber);
  document.getElementById('call-incoming').hidden = false;
  document.getElementById('call-active').hidden = true;
  startRingtone();
}

function showActiveCallScreen(number, phase) {
  stopRingtone();
  document.getElementById('call-incoming').hidden = true;
  document.getElementById('call-active').hidden = false;
  document.getElementById('active-call-number').textContent = contactNameFor(number) || fmtNumber(number);
  document.getElementById('active-call-status').textContent = phase === 'ringing' ? 'Çalıyor…' : 'Görüşme sürüyor';
  document.getElementById('call-timer').textContent = '00:00';

  document.getElementById('island-line').hidden = phase !== 'active';

  if (phase === 'active' && !State.callTimerHandle) {
    State.callStartedAt = Date.now();
    State.callTimerHandle = setInterval(() => {
      const secs = Math.floor((Date.now() - State.callStartedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      document.getElementById('call-timer').textContent = `${mm}:${ss}`;
    }, 1000);
  }
}

function hideCallScreens() {
  stopRingtone();
  document.getElementById('call-incoming').hidden = true;
  document.getElementById('call-active').hidden = true;
  document.getElementById('island-line').hidden = true;
  if (State.callTimerHandle) {
    clearInterval(State.callTimerHandle);
    State.callTimerHandle = null;
  }
  State.activeCallId = null;
  State.callStartedAt = null;
}

document.getElementById('btn-accept').addEventListener('click', async () => {
  const callId = State.activeCallId;
  const res = await post('answerCall', { callId });
  if (!res || !res.success) {
    showToast('error', 'Arama cevaplanamadı.');
    hideCallScreens();
  }
});

document.getElementById('btn-decline').addEventListener('click', async () => {
  await post('declineCall', { callId: State.activeCallId });
  hideCallScreens();
});

document.getElementById('btn-hangup').addEventListener('click', async () => {
  await post('endCall', { callId: State.activeCallId });
  hideCallScreens();
});

/* ------------------------------------------------------------------------ */
/* AÇ / KAPAT                                                                */
/* ------------------------------------------------------------------------ */

function openPhoneUI(view) {
  root.classList.add('open');
  switchView(view || 'home');
  tickClock();
  loadContacts(); // isim çözümlemesi (arama/mesaj listeleri) için erken yükle
}

function closePhoneUI() {
  root.classList.remove('open');
  dialBuffer = '';
  document.getElementById('dial-display').textContent = '';
  const nameEl = document.getElementById('dial-contact-name');
  if (nameEl) nameEl.textContent = '';
}

/* ------------------------------------------------------------------------ */
/* NUI MESAJLARI (Lua -> JS)                                                */
/* ------------------------------------------------------------------------ */

window.addEventListener('message', (ev) => {
  const msg = ev.data || {};

  switch (msg.action) {
    case 'open':
      applyState(msg.state);
      openPhoneUI(msg.view);
      break;

    case 'close':
      closePhoneUI();
      break;

    case 'stateUpdate':
      applyState(msg.state);
      break;

    case 'incomingMessage':
      if (State.currentThreadNumber === msg.message.from_number) {
        const box = document.getElementById('thread-messages');
        box.appendChild(buildMessageBubble(msg.message, false));
        box.scrollTop = box.scrollHeight;
      } else {
        showToast('inform', 'Yeni bir mesajın var.');
      }
      loadThreads();
      break;

    case 'incomingGroupMessage':
      if (currentGroupId === msg.message.groupId) {
        appendGroupBubble(msg.message.from_number, msg.message.body, State.activeNumber);
      } else {
        showToast('inform', 'Bir grupta yeni mesajın var.');
      }
      break;

    case 'incomingShare':
      currentIncomingShareId = msg.data.requestId;
      document.getElementById('airshare-incoming-label').textContent =
        msg.data.kind === 'photo' ? 'Fotoğraf Paylaşım İsteği' : 'Numara Paylaşım İsteği';
      document.getElementById('airshare-incoming-from').textContent = msg.data.fromName;
      document.getElementById('airshare-incoming').hidden = false;
      break;

    case 'shareResult':
      if (msg.data.success) {
        showToast('success', msg.data.kind === 'photo'
          ? `${msg.data.targetName} fotoğrafı kabul etti.`
          : `${msg.data.targetName} numaranı rehberine ekledi.`);
      } else {
        showToast('error', msg.data.reason || 'Paylaşım başarısız.');
      }
      break;

    case 'receiveSharedPhoto':
      GalleryDB.add(msg.data.dataUrl).then(() => {
        showToast('success', `${msg.data.fromName} sizinle bir fotoğraf paylaştı.`);
        if (document.querySelector('.screen-view.active').dataset.view === 'gallery') renderGallery();
      });
      break;

    case 'incomingCall':
      root.classList.add('open');
      showIncomingCallScreen(msg.call);
      break;

    case 'callAnswered': {
      State.activeCallId = msg.callId;
      const other = msg.callerNumber === State.activeNumber ? msg.calleeNumber : msg.callerNumber;
      showActiveCallScreen(other, 'active');
      break;
    }

    case 'callEnded':
      if (State.activeCallId === msg.callId) {
        hideCallScreens();
        if (msg.reason === 'missed') showToast('inform', 'Cevapsız arama.');
      }
      break;

    case 'cameraInput':
      if (State.cameraOpen) handleCameraInput(msg.input);
      break;

    case 'cameraState':
      document.getElementById('camera-selfie').hidden = !msg.selfie;
      break;

    case 'cameraShutter': {
      if (!State.cameraOpen) break;
      if (State.cameraMedia === 'video') {
        if (VideoRec.recording) stopVideoRecording();
        else startVideoRecording();
        break;
      }
      const win = document.getElementById('camera-window');
      win.classList.remove('snap');
      void win.offsetWidth;
      win.classList.add('snap');
      if (msg.flash) triggerFlashPulse();
      takeCameraPhoto(msg.flash);
      break;
    }

    case 'cameraExited':
      if (!State.cameraOpen) break;
      State.cameraOpen = false;
      hideCameraOverlay();
      switchView(State.cameraReturnView || 'home');
      break;

    case 'socialNotify': {
      const labels = { like: 'gönderini beğendi', comment: 'gönderine yorum yaptı', follow: 'seni takip etmeye başladı' };
      showToast('inform', `@${msg.data.fromUsername || 'biri'} ${labels[msg.data.type] || ''}`);
      lifegramPost({ action: 'lifegram:notify', data: msg.data });
      break;
    }

    case 'socialIncomingDirect':
      lifegramPost({ action: 'lifegram:incomingDirect', data: msg.message });
      if (State.social.currentChatCitizenid === msg.message.from_citizenid) {
        const box = document.getElementById('social-chat-messages');
        box.appendChild(buildSocialChatBubble(msg.message, false));
        box.scrollTop = box.scrollHeight;
      } else {
        showToast('inform', `Lifegram: @${msg.message.fromUsername || ''} sana mesaj gönderdi.`);
      }
      if (State.social.activeTab === 'messages' && document.querySelector('.screen-view.active')?.dataset.view === 'social') {
        loadSocialThreads();
      }
      break;

    default:
      break;
  }
});

/* ------------------------------------------------------------------------ */
/* BANKA (App Store'dan indirilir) — "Los Santos Bank"                     */
/*   loe_bank'a HİÇBİR değişiklik yapılmaz; yalnızca onun kendi         */
/*   server API'si (getData/deposit/withdraw/transfer/donate) client/main  */
/*   .lua'daki bankGetData/bankDeposit/... NUI köprüsü üzerinden kullanılır.*/
/* ------------------------------------------------------------------------ */

const BankState = {
  player: { name: 'Müşteri', account: null, cash: 0, bank: 0 },
  bankName: 'LOS SANTOS BANK',
  tx: [],
  donationTotal: 0,
  balHidden: false,
};

function bankGrp(n) { return Math.round(Math.abs(n || 0)).toLocaleString('tr-TR'); }
function bankMoney(n) { return '$' + bankGrp(n); }
function bankMoneySigned(n) {
  const r = Math.round(n || 0);
  return (r < 0 ? '−' : '+') + '$' + bankGrp(r);
}
function bankDigitsOnly(s) { return String(s || '').replace(/[^\d]/g, '').slice(0, 12); }
function bankGetAmt(el) { const d = bankDigitsOnly(el.value); return d ? parseInt(d, 10) : 0; }
function bankAttachAmount(el, onChange) {
  el.addEventListener('input', () => {
    const d = bankDigitsOnly(el.value);
    el.value = d ? parseInt(d, 10).toLocaleString('tr-TR') : '';
    if (onChange) onChange();
  });
}
function bankSetAmt(el, val, onChange) {
  el.value = val > 0 ? Math.floor(val).toLocaleString('tr-TR') : '';
  if (onChange) onChange();
}

function bankApplyResult(res) {
  if (!res || typeof res !== 'object') return;
  if (typeof res.cash === 'number') BankState.player.cash = res.cash;
  if (typeof res.bank === 'number') BankState.player.bank = res.bank;
  if (res.name) BankState.player.name = res.name;
  if (res.account) BankState.player.account = res.account;
  if (res.bankName) BankState.bankName = res.bankName;
  if (typeof res.donationTotal === 'number') BankState.donationTotal = res.donationTotal;
  if (Array.isArray(res.transactions)) BankState.tx = res.transactions;
}

async function bankOpenOverview() {
  const res = await post('bankGetData');
  if (!res || !res.success) {
    showToast('error', (res && res.reason) || 'Banka verisi alınamadı.');
    return;
  }
  bankApplyResult(res);
  try { BankState.balHidden = localStorage.getItem('loe_bank_balHidden') === '1'; } catch (e) { BankState.balHidden = false; }
  bankRenderOverview();
  bankLoadFines();
}

function bankRenderOverview() {
  document.getElementById('bank-account-code').textContent = BankState.player.account || '—';
  document.getElementById('bank-balance').textContent = bankMoney(BankState.player.bank);
  document.getElementById('bank-customer-name').textContent = BankState.player.name || 'Müşteri';

  const cash = BankState.player.cash || 0;
  const bank = BankState.player.bank || 0;
  const cutoff = Date.now() / 1000 - 86400;
  let net24 = 0;
  BankState.tx.forEach((r) => {
    if ((r.ts || 0) >= cutoff) {
      const meta = BANK_TX_META[r.type];
      if (meta) net24 += meta.sign * (Number(r.amount) || 0);
    }
  });

  const stats = [
    { label: 'Nakit', value: bankMoney(cash) },
    { label: 'Banka', value: bankMoney(bank) },
    { label: 'Toplam Varlık', value: bankMoney(cash + bank) },
    { label: 'Son 24 Saat', value: bankMoneySigned(net24), tone: net24 === 0 ? '' : (net24 < 0 ? 'neg' : 'pos') },
  ];
  document.getElementById('bank-stats').innerHTML = stats.map((s) =>
    `<div class="bank-stat-chip"><span>${esc(s.label)}:</span> <b class="${esc(s.tone || '')}">${esc(s.value)}</b></div>`
  ).join('');

  document.getElementById('bank-card').classList.toggle('bal-hidden', BankState.balHidden);
  document.getElementById('bank-eye-label').textContent = BankState.balHidden ? 'Bakiyeyi göster' : 'Bakiyeyi gizle';
  document.getElementById('bank-eye-icon').className = 'icon ' + (BankState.balHidden ? 'icon-bank-eye-off' : 'icon-bank-eye');
}

document.getElementById('bank-eye-toggle').addEventListener('click', () => {
  BankState.balHidden = !BankState.balHidden;
  try { localStorage.setItem('loe_bank_balHidden', BankState.balHidden ? '1' : '0'); } catch (e) { /* localStorage kapalı olabilir */ }
  bankRenderOverview();
});

document.getElementById('bank-refresh').addEventListener('click', bankOpenOverview);

document.getElementById('bank-copy-account').addEventListener('click', async () => {
  const acc = BankState.player.account;
  if (!acc) return;
  const btn = document.getElementById('bank-copy-account');
  let ok = false;
  try { await navigator.clipboard.writeText(acc); ok = true; } catch (e) { /* clipboard API engelli olabilir */ }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = acc;
      ta.style.position = 'fixed'; ta.style.top = '-999px'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* yedek yöntem de başarısız olabilir */ }
  }
  if (ok) {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1400);
    showToast('success', 'Hesap no kopyalandı.');
  } else {
    showToast('error', 'Kopyalanamadı.');
  }
});

document.querySelectorAll('.bank-quick-tile').forEach((btn) => {
  btn.addEventListener('click', () => switchView('banka-' + btn.dataset.bankGo));
});
document.getElementById('bank-open-donate').addEventListener('click', () => switchView('banka-donate'));

/* ---- para yatır / çek / havale / bağış — ortak yardımcılar ---- */

const BANK_OPS = {
  deposit:  { endpoint: 'bankDeposit',  amount: 'bank-dep-amount', submit: 'bank-dep-submit', hint: 'bank-dep-hint' },
  withdraw: { endpoint: 'bankWithdraw', amount: 'bank-wd-amount',  submit: 'bank-wd-submit',  hint: 'bank-wd-hint' },
  transfer: { endpoint: 'bankTransfer', amount: 'bank-tr-amount',  submit: 'bank-tr-submit',  hint: 'bank-tr-hint' },
  donate:   { endpoint: 'bankDonate',   amount: 'bank-don-amount', submit: 'bank-don-submit', hint: 'bank-don-hint' },
};

function bankSetHint(el, kind, text) {
  el.className = 'bank-op-hint' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

function bankRenderForms() {
  const cash = BankState.player.cash || 0;
  const bank = BankState.player.bank || 0;

  document.getElementById('bank-dep-from').textContent = bankMoney(cash);
  document.getElementById('bank-dep-to').textContent = bankMoney(bank);
  const depAmt = bankGetAmt(document.getElementById('bank-dep-amount'));
  const depBad = depAmt > cash;
  document.getElementById('bank-dep-submit').disabled = depAmt <= 0 || depBad;
  bankSetHint(document.getElementById('bank-dep-hint'), depBad ? 'err' : '', depBad ? 'Üzerinde bu kadar nakit yok.' : '');

  document.getElementById('bank-wd-from').textContent = bankMoney(bank);
  document.getElementById('bank-wd-to').textContent = bankMoney(cash);
  const wdAmt = bankGetAmt(document.getElementById('bank-wd-amount'));
  const wdBad = wdAmt > bank;
  document.getElementById('bank-wd-submit').disabled = wdAmt <= 0 || wdBad;
  bankSetHint(document.getElementById('bank-wd-hint'), wdBad ? 'err' : '', wdBad ? 'Banka bakiyen bu kadar değil.' : '');

  document.getElementById('bank-tr-from').textContent = bankMoney(bank);
  const acc = document.getElementById('bank-tr-account').value.trim().toUpperCase();
  document.getElementById('bank-tr-to').textContent = acc || '—';
  const accOk = /^[A-Z0-9]{4}$/.test(acc);
  const trAmt = bankGetAmt(document.getElementById('bank-tr-amount'));
  document.getElementById('bank-tr-fee').textContent = bankMoney(0);
  const trBad = trAmt > bank;
  document.getElementById('bank-tr-submit').disabled = trAmt <= 0 || !accOk || trBad;
  if (acc && !accOk) bankSetHint(document.getElementById('bank-tr-hint'), 'err', 'Hesap no 4 hane olmalı (harf + rakam).');
  else if (trBad) bankSetHint(document.getElementById('bank-tr-hint'), 'err', 'Banka bakiyen yetersiz.');
  else bankSetHint(document.getElementById('bank-tr-hint'), '', '');

  document.getElementById('bank-don-from').textContent = bankMoney(bank);
  document.getElementById('bank-don-total').textContent = bankMoney(BankState.donationTotal || 0);
  const donAmt = bankGetAmt(document.getElementById('bank-don-amount'));
  const donBad = donAmt > bank;
  document.getElementById('bank-don-submit').disabled = donAmt <= 0 || donBad;
  bankSetHint(document.getElementById('bank-don-hint'), donBad ? 'err' : '', donBad ? 'Banka bakiyen yetersiz.' : '');
}

const BANK_AMT_ID = { dep: 'bank-dep-amount', wd: 'bank-wd-amount', tr: 'bank-tr-amount', don: 'bank-don-amount' };
function bankChipEl(kind) { return document.getElementById(BANK_AMT_ID[kind]); }
function bankChipBase(kind) { return kind === 'dep' ? (BankState.player.cash || 0) : (BankState.player.bank || 0); }

function bankMkChip(label, fn, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bank-chip-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function bankBuildChips() {
  document.querySelectorAll('.bank-chip-row[data-bank-chips]').forEach((box) => {
    const kind = box.dataset.bankChips;
    box.innerHTML = '';
    if (kind === 'tr') {
      [100, 500, 1000, 5000, 10000].forEach((v) => {
        box.appendChild(bankMkChip(v.toLocaleString('tr-TR'), () => {
          const el = bankChipEl(kind);
          bankSetAmt(el, bankGetAmt(el) + v, bankRenderForms);
        }));
      });
      box.appendChild(bankMkChip('Tümü', () => {
        bankSetAmt(bankChipEl(kind), BankState.player.bank || 0, bankRenderForms);
      }, 'max'));
    } else {
      [25, 50, 75, 100].forEach((pct) => {
        box.appendChild(bankMkChip('%' + pct, () => {
          bankSetAmt(bankChipEl(kind), Math.floor(bankChipBase(kind) * pct / 100), bankRenderForms);
        }, pct === 100 ? 'max' : ''));
      });
    }
  });
}
bankBuildChips();

bankAttachAmount(document.getElementById('bank-dep-amount'), bankRenderForms);
bankAttachAmount(document.getElementById('bank-wd-amount'), bankRenderForms);
bankAttachAmount(document.getElementById('bank-tr-amount'), bankRenderForms);
bankAttachAmount(document.getElementById('bank-don-amount'), bankRenderForms);
document.getElementById('bank-tr-account').addEventListener('input', (ev) => {
  ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  bankRenderForms();
});

async function bankSubmitOp(kind) {
  const cfg = BANK_OPS[kind];
  const amountEl = document.getElementById(cfg.amount);
  const amt = bankGetAmt(amountEl);
  const hintEl = document.getElementById(cfg.hint);
  if (amt <= 0) return bankSetHint(hintEl, 'err', 'Bir tutar gir.');

  const payload = { amount: amt };
  if (kind === 'transfer') {
    payload.account = document.getElementById('bank-tr-account').value.trim().toUpperCase();
    payload.note = document.getElementById('bank-tr-note').value.trim();
    if (!/^[A-Z0-9]{4}$/.test(payload.account)) return bankSetHint(hintEl, 'err', 'Alıcı hesap no 4 hane olmalı.');
  }

  document.getElementById(cfg.submit).disabled = true;
  bankSetHint(hintEl, '', 'İşleniyor…');

  const res = await post(cfg.endpoint, payload);
  bankApplyResult(res);

  if (res && res.success) {
    amountEl.value = '';
    if (kind === 'transfer') {
      document.getElementById('bank-tr-note').value = '';
      document.getElementById('bank-tr-account').value = '';
    }
    bankSetHint(hintEl, 'ok', res.message || 'İşlem tamamlandı.');
    showToast('success', res.message || 'İşlem tamamlandı.');
  } else {
    bankSetHint(hintEl, 'err', (res && res.reason) || 'İşlem başarısız.');
    showToast('error', (res && res.reason) || 'İşlem başarısız.');
  }

  bankRenderOverview();
  bankRenderForms();
  bankRenderHistory();
}

document.getElementById('bank-dep-submit').addEventListener('click', () => bankSubmitOp('deposit'));
document.getElementById('bank-wd-submit').addEventListener('click', () => bankSubmitOp('withdraw'));
document.getElementById('bank-tr-submit').addEventListener('click', () => bankSubmitOp('transfer'));
document.getElementById('bank-don-submit').addEventListener('click', () => bankSubmitOp('donate'));

[['bank-dep-amount', 'deposit'], ['bank-wd-amount', 'withdraw'], ['bank-tr-amount', 'transfer'], ['bank-tr-note', 'transfer'], ['bank-don-amount', 'donate']].forEach(([id, kind]) => {
  document.getElementById(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !document.getElementById(BANK_OPS[kind].submit).disabled) bankSubmitOp(kind);
  });
});

/* ---- son işlemler ---- */

const BANK_TX_META = {
  deposit:      { icon: 'icon-bank-deposit',  sign: +1, color: '#34e07f' },
  withdraw:     { icon: 'icon-bank-withdraw', sign: -1, color: '#ffb648' },
  transfer_in:  { icon: 'icon-bank-arrow',    sign: +1, color: '#34e07f' },
  transfer_out: { icon: 'icon-send',          sign: -1, color: '#ff2e97' },
  donation:     { icon: 'icon-bank-heart',    sign: -1, color: '#ff2e97' },
};

function bankHexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const BANK_MONTHS_TR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
function bankPad2(n) { return String(n).padStart(2, '0'); }
function bankFmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = bankPad2(d.getHours()) + ':' + bankPad2(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return 'Bugün ' + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Dün ' + hm;
  return d.getDate() + ' ' + BANK_MONTHS_TR[d.getMonth()];
}

function bankRenderHistory() {
  const list = document.getElementById('bank-tx-list');
  const empty = document.getElementById('bank-tx-empty');
  list.innerHTML = '';
  empty.hidden = BankState.tx.length > 0;

  BankState.tx.forEach((r) => {
    const m = BANK_TX_META[r.type] || { icon: 'icon-bank-history', sign: +1, color: '#b46bff' };
    const li = document.createElement('li');
    li.className = 'bank-tx-row';
    li.style.setProperty('--cat', m.color);
    li.style.setProperty('--cat-bg', bankHexA(m.color, 0.16));
    li.innerHTML = `
      <span class="bank-tx-icon"><span class="icon ${esc(m.icon)}"></span></span>
      <div class="bank-tx-main">
        <div class="bank-tx-title">${esc(r.title || '')}</div>
        <div class="bank-tx-sub">${esc(r.description || r.counterparty || '')}</div>
      </div>
      <div class="bank-tx-right">
        <div class="bank-tx-amt ${m.sign < 0 ? 'neg' : 'pos'}">${esc(bankMoneySigned(m.sign * (Number(r.amount) || 0)))}</div>
        <div class="bank-tx-when">${esc(bankFmtWhen(r.ts))}</div>
      </div>
    `;
    list.appendChild(li);
  });
}

/* ---- cezalar: polisin kestiği ödenmemiş cezalar (loe_jobcreator) ---- */

const BankFines = { list: [] };

function bankFineWhat(fine) {
  return (fine.offences || []).map((o) => (o.code ? o.code + ' ' : '') + (o.label || '')).join(', ');
}

function bankRenderFinesCount() {
  const el = document.getElementById('bank-fines-count');
  if (!el) return;
  const unpaid = BankFines.list.filter((f) => !f.paid).length;
  el.hidden = unpaid === 0;
  el.textContent = String(unpaid);
}

async function bankLoadFines() {
  const res = await post('bankGetFines');
  if (!res || !res.success) {
    BankFines.list = [];
    bankRenderFinesCount();
    return res;
  }
  BankFines.list = Array.isArray(res.fines) ? res.fines : [];
  bankRenderFinesCount();
  return res;
}

async function bankOpenFines() {
  const res = await bankLoadFines();
  if (!res || !res.success) showToast('error', (res && res.reason) || 'Cezalar alınamadı.');
  bankRenderFines();
}

function bankRenderFines() {
  const list = document.getElementById('bank-fines-list');
  const empty = document.getElementById('bank-fines-empty');
  list.innerHTML = '';
  empty.hidden = BankFines.list.length > 0;

  BankFines.list.forEach((fine) => {
    const li = document.createElement('li');
    li.className = 'bank-tx-row bank-fine-row';
    li.style.setProperty('--cat', '#ff2e97');
    li.style.setProperty('--cat-bg', bankHexA('#ff2e97', 0.16));
    li.innerHTML = `
      <span class="bank-tx-icon"><span class="icon icon-bank-history"></span></span>
      <div class="bank-tx-main">
        <div class="bank-tx-title">${esc((fine.job || '').toUpperCase())} · #${esc(fine.id)}${fine.callsign ? ' · ' + esc(fine.callsign) : ''}</div>
        <div class="bank-tx-sub bank-fine-what">${esc(bankFineWhat(fine))}</div>
        ${fine.note ? `<div class="bank-tx-sub bank-fine-note">${esc(fine.note)}</div>` : ''}
      </div>
      <div class="bank-tx-right">
        <div class="bank-tx-amt ${fine.paid ? 'pos' : 'neg'}">${esc(bankMoney(fine.amount))}</div>
        <div class="bank-tx-when">${esc(bankFmtWhen(fine.at))}</div>
        ${fine.paid
          ? `<div class="bank-fine-paid">Ödendi${fine.paidAt ? ' · ' + esc(bankFmtWhen(fine.paidAt)) : ''}</div>`
          : '<button type="button" class="bank-chip-btn bank-fine-pay">Öde</button>'}
      </div>
    `;
    const payBtn = li.querySelector('.bank-fine-pay');
    if (payBtn) payBtn.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      if ((BankState.player.bank || 0) < (fine.amount || 0)) {
        showToast('error', 'Banka bakiyen yetersiz.');
        return;
      }
      btn.disabled = true;
      const res = await post('bankPayFine', { id: fine.id });
      if (!res || !res.success) {
        btn.disabled = false;
        showToast('error', (res && res.reason) || 'Ödenemedi.');
        return;
      }
      showToast('success', (res && res.reason) || 'Ceza ödendi.');
      const data = await post('bankGetData');
      if (data && data.success) { bankApplyResult(data); bankRenderOverview(); }
      await bankLoadFines();
      bankRenderFines();
    });
    list.appendChild(li);
  });
}

/* ------------------------------------------------------------------------ */
/* LIFEGRAM (App Store'dan indirilir) — fotoğraf paylaşım/sosyal medya       */
/*   loe_lifegram'ya HİÇBİR değişiklik yapılmaz; yalnızca onun kendi  */
/*   server API'si client/main.lua'daki socialXxx NUI köprüsü üzerinden     */
/*   kullanılır (Banka ile aynı desen).                                     */
/* ------------------------------------------------------------------------ */

State.social = {
  me: null,
  activeTab: 'feed',
  feedCursor: null,
  feedLoading: false,
  exploreCursor: null,
  exploreLoading: false,
  currentPostForComments: null,
  currentChatCitizenid: null,
  currentChatUsername: null,
  newPostType: 'post',
  newPostPhoto: null,
  currentStoryList: [],
  currentStoryIndex: 0,
  storyTimer: null,
  shareTargetPostId: null,
  pendingAvatar: undefined,
};

/** Avatar yoksa kullanıcı adının baş harfinden deterministik, renkli bir
 *  SVG avatar üretir — harici asset gerektirmez, her hesap için sabit kalır. */
function socialInitialAvatar(name) {
  const label = (name || '?');
  const ch = label.charAt(0).toUpperCase();
  let hue = 0;
  for (let i = 0; i < label.length; i++) hue = (hue + label.charCodeAt(i)) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='32' fill='hsl(${hue},42%,32%)'/><text x='32' y='43' font-family='sans-serif' font-size='28' font-weight='700' fill='white' text-anchor='middle'>${ch}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function socialAvatarSrc(avatar, username) {
  return avatar || socialInitialAvatar(username);
}

const SOCIAL_STORY_DURATION_MS = 5000;

/* ---- açılış / kendi hesabım ------------------------------------------- */

async function openSocialHome() {
  const res = await post('socialGetMe');
  if (!res || !res.success) {
    if (res && res.reason === 'no_account') {
      document.getElementById('social-onboard-username').value = '';
      document.getElementById('social-onboard-bio').value = '';
      document.getElementById('social-onboard-hint').textContent = '';
      return switchView('social-onboarding');
    }
    showToast('error', (res && res.reason) || 'Lifegram şu anda kullanılamıyor.');
    return switchView('home');
  }
  State.social.me = res.me;
  renderSocialSelf();
  activateSocialTab(State.social.activeTab || 'feed');
}

function renderSocialSelf() {
  const me = State.social.me;
  if (!me) return;
  document.getElementById('social-nav-avatar').src = socialAvatarSrc(me.avatar, me.username);
  document.getElementById('social-own-username-header').textContent = '@' + me.username;
}

document.getElementById('social-onboard-submit').addEventListener('click', async () => {
  const username = document.getElementById('social-onboard-username').value.trim();
  const bio = document.getElementById('social-onboard-bio').value.trim();
  const hint = document.getElementById('social-onboard-hint');
  if (!username) { hint.textContent = 'Bir kullanıcı adı gir.'; return; }
  const res = await post('socialRegister', { username, bio });
  if (!res || !res.success) { hint.textContent = (res && res.reason) || 'Kayıt olunamadı.'; return; }
  State.social.me = res.me;
  renderSocialSelf();
  switchView('social');
  activateSocialTab('feed');
});

/* ---- sekme geçişi ------------------------------------------------------ */

function activateSocialTab(tab) {
  State.social.activeTab = tab;
  document.querySelectorAll('.social-tab-panel').forEach((el) => el.classList.toggle('active', el.dataset.socialTab === tab));
  document.querySelectorAll('.social-nav-btn').forEach((el) => el.classList.toggle('active', el.dataset.socialTab === tab));
  if (tab === 'feed') { loadSocialStories(); loadSocialFeed(true); }
  if (tab === 'explore') loadSocialExplore(true);
  if (tab === 'messages') loadSocialThreads();
  if (tab === 'profile') loadSocialOwnProfile();
}

document.getElementById('social-bottom-nav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.social-nav-btn');
  if (!btn) return;
  activateSocialTab(btn.dataset.socialTab);
});

/* ---- gönderi kartı (Ana Sayfa + tekil gönderi görünümünde ortak) ------- */

function buildSocialPostCard(p) {
  const el = document.createElement('article');
  el.className = 'social-post';
  el.dataset.postId = p.id;
  el.dataset.citizenid = p.citizenid;

  let likesHtml = '';
  if (p.likeCount > 0) {
    if (p.firstLiker && p.likeCount > 1) {
      likesHtml = `<b>${esc(p.firstLiker)}</b> ve diğer <b>${p.likeCount - 1}</b> kişi beğendi`;
    } else if (p.firstLiker) {
      likesHtml = `<b>${esc(p.firstLiker)}</b> beğendi`;
    } else {
      likesHtml = `<b>${p.likeCount}</b> beğenme`;
    }
  }

  el.innerHTML = `
    <div class="social-post-header">
      <img class="social-avatar" data-open-profile="${esc(p.citizenid)}" src="${socialAvatarSrc(p.avatar, p.username)}" alt="" style="width:32px;height:32px" />
      <div class="social-post-user" data-open-profile="${esc(p.citizenid)}">
        <div class="social-post-username">${esc(p.username)}</div>
        ${p.location ? `<div class="social-post-location">${esc(p.location)}</div>` : ''}
      </div>
      <button class="social-post-more" type="button" aria-label="Menü"><span class="icon icon-social-more"></span></button>
    </div>
    <div class="social-post-media"><img src="${p.photo}" alt="" /></div>
    <div class="social-post-actions">
      <button class="social-action-btn social-like-btn" type="button" aria-label="Beğen">
        <span class="icon ${p.likedByMe ? 'icon-social-heart-fill' : 'icon-social-heart'}"></span>
      </button>
      <button class="social-action-btn social-comment-btn" type="button" aria-label="Yorum yap"><span class="icon icon-message"></span></button>
      <button class="social-action-btn social-share-btn" type="button" aria-label="Gönder"><span class="icon icon-send"></span></button>
      <button class="social-action-btn social-post-actions-right" type="button" aria-label="Kaydet"><span class="icon icon-social-bookmark"></span></button>
    </div>
    <div class="social-post-likes" ${p.likeCount > 0 ? '' : 'hidden'}>${likesHtml}</div>
    ${p.caption ? `<div class="social-post-caption"><b>${esc(p.username)}</b>${esc(p.caption)}</div>` : ''}
    <div class="social-post-comments-link" ${p.commentCount > 0 ? '' : 'hidden'}>${p.commentCount || 0} yorumun tümünü gör</div>
    <div class="social-post-time">${esc(fmtRelative(p.ts))}</div>
  `;
  return el;
}

async function handleSocialPostClick(ev) {
  const article = ev.target.closest('.social-post');
  if (!article) return;
  const postId = Number(article.dataset.postId);

  const profileOpen = ev.target.closest('[data-open-profile]');
  if (profileOpen) return openSocialProfile(profileOpen.dataset.openProfile);

  const moreBtn = ev.target.closest('.social-post-more');
  if (moreBtn) {
    if (!State.social.me || State.social.me.citizenid !== article.dataset.citizenid) {
      showToast('inform', 'Bu gönderi sana ait değil.');
      return;
    }
    const res = await post('socialDeletePost', { postId });
    if (!res || !res.success) return showToast('error', (res && res.reason) || 'Silinemedi.');
    article.remove();
    showToast('success', 'Gönderi silindi.');
    return;
  }

  const likeBtn = ev.target.closest('.social-like-btn');
  if (likeBtn) {
    const res = await post('socialToggleLike', { postId });
    if (!res || !res.success) return showToast('error', (res && res.reason) || 'İşlem başarısız.');
    likeBtn.querySelector('.icon').className = 'icon ' + (res.liked ? 'icon-social-heart-fill' : 'icon-social-heart');
    likeBtn.classList.toggle('liked', res.liked);
    const likesRow = article.querySelector('.social-post-likes');
    if (likesRow) {
      likesRow.hidden = res.likeCount <= 0;
      likesRow.innerHTML = res.likeCount > 0 ? `<b>${res.likeCount}</b> beğenme` : '';
    }
    return;
  }

  if (ev.target.closest('.social-comment-btn') || ev.target.closest('.social-post-comments-link')) {
    return openSocialComments(postId);
  }
  if (ev.target.closest('.social-share-btn')) return openSocialShare(postId);
}

document.getElementById('social-feed').addEventListener('click', handleSocialPostClick);
document.getElementById('social-post-detail-content').addEventListener('click', handleSocialPostClick);

/* ---- Ana Sayfa akışı ---------------------------------------------------- */

async function loadSocialFeed(reset) {
  if (reset) { State.social.feedCursor = null; document.getElementById('social-feed').innerHTML = ''; }
  if (State.social.feedLoading) return;
  State.social.feedLoading = true;
  const res = await post('socialGetFeed', { cursor: State.social.feedCursor });
  State.social.feedLoading = false;

  const list = document.getElementById('social-feed');
  const empty = document.getElementById('social-feed-empty');
  const moreBtn = document.getElementById('social-feed-more');
  if (!res || !res.success) { showToast('error', 'Akış yüklenemedi.'); return; }

  res.posts.forEach((p) => list.appendChild(buildSocialPostCard(p)));
  empty.hidden = list.children.length > 0;
  State.social.feedCursor = res.nextCursor || null;
  moreBtn.hidden = !res.nextCursor;
}
document.getElementById('social-feed-more').addEventListener('click', () => loadSocialFeed(false));

/* ---- hikayeler ----------------------------------------------------------- */

async function loadSocialStories() {
  const res = await post('socialGetStoriesStrip');
  const strip = document.getElementById('social-stories');
  strip.innerHTML = '';
  if (!res || !res.success || !State.social.me) return;

  const list = res.stories.slice();
  const selfIdx = list.findIndex((s) => s.isSelf);
  let selfEntry;
  if (selfIdx !== -1) { selfEntry = list.splice(selfIdx, 1)[0]; }
  else selfEntry = { citizenid: State.social.me.citizenid, username: State.social.me.username, avatar: State.social.me.avatar, isSelf: true, hasUnseen: false, storyCount: 0 };
  list.unshift(selfEntry);

  list.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'social-story-item';
    btn.type = 'button';
    const ringClass = s.isSelf ? (Number(s.storyCount) > 0 ? '' : 'self') : (s.hasUnseen ? '' : 'seen');
    btn.innerHTML = `
      <span class="social-story-ring ${ringClass}">
        <img class="social-avatar" src="${socialAvatarSrc(s.avatar, s.username)}" alt="" style="width:100%;height:100%" />
        ${s.isSelf ? '<span class="social-story-add-badge"><span class="icon icon-plus"></span></span>' : ''}
      </span>
      <label>${s.isSelf ? 'Hikayen' : esc(s.username)}</label>
    `;
    btn.addEventListener('click', () => {
      if (s.isSelf && !Number(s.storyCount)) return openSocialStoryComposer();
      openSocialStory(s.citizenid);
    });
    strip.appendChild(btn);
  });
}

async function openSocialStory(citizenid) {
  const res = await post('socialGetStory', { citizenid });
  if (!res || !res.success || !res.stories.length) return showToast('inform', 'Aktif hikaye yok.');
  State.social.currentStoryList = res.stories;
  State.social.currentStoryIndex = 0;
  document.getElementById('social-story-username').textContent = res.username;
  document.getElementById('social-story-avatar').src = socialAvatarSrc(res.avatar, res.username);
  document.getElementById('social-story-reply-input').dataset.to = citizenid;
  buildSocialStorySegments(res.stories.length);
  document.getElementById('social-story-viewer').hidden = false;
  showSocialStoryAt(0);
}

function buildSocialStorySegments(count) {
  const wrap = document.getElementById('social-story-segments');
  wrap.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = '<div class="fill"></div>';
    wrap.appendChild(seg);
  }
}

function showSocialStoryAt(index) {
  const list = State.social.currentStoryList;
  if (index < 0) return;
  if (index >= list.length) return closeSocialStory();

  State.social.currentStoryIndex = index;
  const story = list[index];
  document.getElementById('social-story-photo').src = story.photo;
  document.getElementById('social-story-time').textContent = fmtRelative(story.ts);

  const segs = document.querySelectorAll('#social-story-segments .seg');
  segs.forEach((seg, i) => {
    seg.classList.toggle('done', i < index);
    const fill = seg.querySelector('.fill');
    fill.style.transition = 'none';
    fill.style.width = i < index ? '100%' : '0%';
  });

  if (!story.seenByMe) post('socialMarkStorySeen', { storyId: story.id });

  clearTimeout(State.social.storyTimer);
  requestAnimationFrame(() => {
    const fill = segs[index] && segs[index].querySelector('.fill');
    if (!fill) return;
    fill.style.transition = `width ${SOCIAL_STORY_DURATION_MS}ms linear`;
    fill.style.width = '100%';
  });
  State.social.storyTimer = setTimeout(() => showSocialStoryAt(index + 1), SOCIAL_STORY_DURATION_MS);
}

function closeSocialStory() {
  clearTimeout(State.social.storyTimer);
  document.getElementById('social-story-viewer').hidden = true;
  loadSocialStories();
}

document.getElementById('social-story-close').addEventListener('click', closeSocialStory);
document.getElementById('social-story-prev').addEventListener('click', () => {
  clearTimeout(State.social.storyTimer);
  showSocialStoryAt(State.social.currentStoryIndex - 1);
});
document.getElementById('social-story-next').addEventListener('click', () => {
  clearTimeout(State.social.storyTimer);
  showSocialStoryAt(State.social.currentStoryIndex + 1);
});
document.getElementById('social-story-reply-send').addEventListener('click', async () => {
  const input = document.getElementById('social-story-reply-input');
  const body = input.value.trim();
  const to = input.dataset.to;
  if (!body || !to) return;
  const res = await post('socialSendMessage', { to, body });
  if (res && res.success) { input.value = ''; showToast('success', 'Gönderildi.'); }
  else showToast('error', (res && res.reason) || 'Gönderilemedi.');
});

function openSocialStoryComposer() {
  State.social.newPostType = 'story';
  State.social.newPostPhoto = null;
  document.querySelectorAll('#social-post-type .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.postType === 'story'));
  document.getElementById('social-post-fields').hidden = true;
  const preview = document.getElementById('social-new-post-preview');
  preview.hidden = true;
  document.getElementById('social-pick-photo-label').hidden = false;
  switchView('social-new-post');
}

/* ---- Keşfet -------------------------------------------------------------- */

async function loadSocialExplore(reset) {
  if (reset) { State.social.exploreCursor = null; document.getElementById('social-explore-grid').innerHTML = ''; }
  if (State.social.exploreLoading) return;
  State.social.exploreLoading = true;
  const res = await post('socialGetExplore', { cursor: State.social.exploreCursor });
  State.social.exploreLoading = false;

  const grid = document.getElementById('social-explore-grid');
  const empty = document.getElementById('social-explore-empty');
  if (!res || !res.success) return;

  res.posts.forEach((p) => {
    const tile = document.createElement('div');
    tile.className = 'social-explore-tile';
    tile.innerHTML = `
      <img src="${p.photo}" alt="" />
      <span class="social-explore-stat"><span class="icon icon-social-heart-fill"></span>${p.likeCount || 0}</span>
    `;
    tile.addEventListener('click', () => openSocialPostDetail(p.id));
    grid.appendChild(tile);
  });
  empty.hidden = grid.children.length > 0;
  State.social.exploreCursor = res.nextCursor || null;
}

const socialExploreScroll = document.querySelector('#social-tab-explore .social-scroll');
if (socialExploreScroll) {
  socialExploreScroll.addEventListener('scroll', function () {
    if (State.social.activeTab !== 'explore') return;
    if (this.scrollTop + this.clientHeight > this.scrollHeight - 300) loadSocialExplore(false);
  });
}

document.getElementById('social-search-input').addEventListener('focus', () => {
  document.getElementById('social-explore-grid').hidden = true;
  document.getElementById('social-search-results').hidden = false;
  renderSocialSearchResults('');
});
document.getElementById('social-search-input').addEventListener('blur', () => {
  setTimeout(() => {
    if (!document.getElementById('social-search-input').value.trim()) {
      document.getElementById('social-explore-grid').hidden = false;
      document.getElementById('social-search-results').hidden = true;
    }
  }, 150);
});
let socialExploreSearchTimer = null;
document.getElementById('social-search-input').addEventListener('input', (ev) => {
  clearTimeout(socialExploreSearchTimer);
  const q = ev.target.value.trim();
  socialExploreSearchTimer = setTimeout(() => renderSocialSearchResults(q), 250);
});

async function renderSocialSearchResults(query) {
  const res = await post('socialSearchUsers', { query });
  const list = document.getElementById('social-search-results');
  const empty = document.getElementById('social-search-empty');
  list.innerHTML = '';
  if (!res || !res.success) return;
  res.users.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <img class="social-avatar" src="${socialAvatarSrc(u.avatar, u.username)}" alt="" style="width:44px;height:44px" />
      <div class="row-main">
        <div class="row-title">${esc(u.username)}</div>
        <div class="row-sub">${u.followerCount} takipçi</div>
      </div>
    `;
    li.addEventListener('click', () => openSocialProfile(u.citizenid));
    list.appendChild(li);
  });
  empty.hidden = res.users.length > 0;
}

/* ---- tekil gönderi görünümü (Keşfet/Profil ızgarasından) ----------------- */

async function openSocialPostDetail(postId) {
  const content = document.getElementById('social-post-detail-content');
  content.innerHTML = '<p class="empty-hint">Yükleniyor…</p>';
  openSheet('social-post-detail-sheet');
  const res = await post('socialGetPost', { postId });
  if (!res || !res.success) {
    content.innerHTML = `<p class="empty-hint">${esc((res && res.reason) || 'Gönderi bulunamadı.')}</p>`;
    return;
  }
  content.innerHTML = '';
  content.appendChild(buildSocialPostCard(res.post));
}
document.getElementById('social-post-detail-backdrop').addEventListener('click', () => closeSheet('social-post-detail-sheet'));

/* ---- profil (kendi + başkası ortak render) ------------------------------- */

function renderSocialProfileInto(container, p, mode) {
  let actionsHtml;
  if (mode === 'own') {
    actionsHtml = `
      <button class="social-profile-btn" id="social-edit-open-btn" type="button">Düzenle</button>
      <button class="social-profile-btn" type="button" disabled>Profili paylaş</button>
    `;
  } else {
    actionsHtml = `
      <button class="social-profile-btn ${p.isFollowedByMe ? 'following' : 'primary'}" id="social-follow-btn" data-citizenid="${esc(p.citizenid)}" type="button">${p.isFollowedByMe ? 'Takip Ediliyor' : 'Takip Et'}</button>
      <button class="social-profile-btn" id="social-message-btn" data-citizenid="${esc(p.citizenid)}" data-username="${esc(p.username)}" data-avatar="${esc(p.avatar || '')}" type="button">Mesaj</button>
    `;
  }
  container.innerHTML = `
    <div class="social-profile-header">
      <img class="social-avatar has-ring" src="${socialAvatarSrc(p.avatar, p.username)}" alt="" style="width:84px;height:84px" />
      <div class="social-profile-stats">
        <div class="social-profile-stat"><b>${p.postCount}</b><span>gönderi</span></div>
        <div class="social-profile-stat"><b>${p.followerCount}</b><span>takipçi</span></div>
        <div class="social-profile-stat"><b>${p.followingCount}</b><span>takip</span></div>
      </div>
    </div>
    <div class="social-profile-name">${esc(p.username)}</div>
    ${p.bio ? `<div class="social-profile-bio">${esc(p.bio)}</div>` : ''}
    <div class="social-profile-actions">${actionsHtml}</div>
    <div class="social-profile-grid"></div>
  `;
  loadSocialProfileGrid(container.querySelector('.social-profile-grid'), p.citizenid);
}

async function loadSocialProfileGrid(gridEl, citizenid) {
  const res = await post('socialGetProfilePosts', { citizenid });
  if (!gridEl) return;
  gridEl.innerHTML = '';
  if (!res || !res.success) return;
  res.posts.forEach((p) => {
    const tile = document.createElement('div');
    tile.className = 'social-explore-tile';
    tile.innerHTML = `<img src="${p.photo}" alt="" />`;
    tile.addEventListener('click', () => openSocialPostDetail(p.id));
    gridEl.appendChild(tile);
  });
  if (!gridEl.children.length) gridEl.insertAdjacentHTML('beforeend', '<p class="social-profile-empty">Henüz gönderi yok.</p>');
}

async function loadSocialOwnProfile() {
  const res = await post('socialGetProfile', {});
  if (!res || !res.success) return;
  State.social.me = Object.assign(State.social.me || {}, res.profile);
  renderSocialSelf();
  renderSocialProfileInto(document.getElementById('social-own-profile'), res.profile, 'own');
}

async function openSocialProfile(citizenid) {
  if (State.social.me && citizenid === State.social.me.citizenid) {
    switchView('social');
    activateSocialTab('profile');
    return;
  }
  const res = await post('socialGetProfile', { citizenid });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Profil bulunamadı.');
  document.getElementById('social-other-username-header').textContent = '@' + res.profile.username;
  renderSocialProfileInto(document.getElementById('social-other-profile'), res.profile, 'other');
  switchView('social-user-profile');
}

document.getElementById('social-own-profile').addEventListener('click', (ev) => {
  if (ev.target.closest('#social-edit-open-btn')) openSocialEditProfile();
});

document.getElementById('social-other-profile').addEventListener('click', async (ev) => {
  const followBtn = ev.target.closest('#social-follow-btn');
  const msgBtn = ev.target.closest('#social-message-btn');
  if (followBtn) {
    const res = await post('socialToggleFollow', { citizenid: followBtn.dataset.citizenid });
    if (!res || !res.success) return showToast('error', (res && res.reason) || 'İşlem başarısız.');
    followBtn.textContent = res.following ? 'Takip Ediliyor' : 'Takip Et';
    followBtn.classList.toggle('following', res.following);
    followBtn.classList.toggle('primary', !res.following);
    const statEl = document.querySelector('#social-other-profile .social-profile-stat:nth-child(2) b');
    if (statEl) statEl.textContent = res.followerCount;
    return;
  }
  if (msgBtn) openSocialChat(msgBtn.dataset.citizenid, msgBtn.dataset.username, msgBtn.dataset.avatar);
});

document.getElementById('social-own-menu-btn').addEventListener('click', openSocialEditProfile);

/* ---- profili düzenle ------------------------------------------------------ */

function openSocialEditProfile() {
  const me = State.social.me;
  if (!me) return;
  document.getElementById('social-edit-username').value = me.username || '';
  document.getElementById('social-edit-bio').value = me.bio || '';
  const img = document.getElementById('social-edit-avatar-preview');
  const label = document.getElementById('social-edit-avatar-label');
  if (me.avatar) { img.src = me.avatar; img.hidden = false; label.textContent = 'Fotoğrafı Değiştir'; }
  else { img.hidden = true; label.textContent = 'Fotoğraf Ekle'; }
  State.social.pendingAvatar = undefined;
  document.getElementById('social-edit-hint').textContent = '';
  switchView('social-edit-profile');
}

document.getElementById('social-edit-avatar-btn').addEventListener('click', async () => {
  const grid = document.getElementById('social-avatar-photo-grid');
  const empty = document.getElementById('social-avatar-photo-empty');
  grid.innerHTML = '';
  let photos = [];
  try { photos = await GalleryDB.listPhotos(); } catch (e) { /* desteklenmiyor olabilir */ }
  empty.hidden = photos.length > 0;
  photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${p.dataUrl}" alt="" />`;
    div.addEventListener('click', () => {
      closeSheet('social-avatar-photo-sheet');
      State.social.pendingAvatar = p.dataUrl;
      const img = document.getElementById('social-edit-avatar-preview');
      img.src = p.dataUrl; img.hidden = false;
      document.getElementById('social-edit-avatar-label').textContent = 'Fotoğrafı Değiştir';
    });
    grid.appendChild(div);
  });
  openSheet('social-avatar-photo-sheet');
});
document.getElementById('social-avatar-photo-backdrop').addEventListener('click', () => closeSheet('social-avatar-photo-sheet'));

document.getElementById('social-edit-save').addEventListener('click', async () => {
  const username = document.getElementById('social-edit-username').value.trim();
  const bio = document.getElementById('social-edit-bio').value.trim();
  const hint = document.getElementById('social-edit-hint');
  const payload = { username, bio };
  if (State.social.pendingAvatar !== undefined) payload.avatar = await compressDataUrl(State.social.pendingAvatar);
  const res = await post('socialUpdateProfile', payload);
  if (!res || !res.success) { hint.textContent = (res && res.reason) || 'Kaydedilemedi.'; return; }
  State.social.me = res.me;
  renderSocialSelf();
  showToast('success', 'Profil güncellendi.');
  switchView('social');
  activateSocialTab('profile');
});

/* ---- Mesajlar (uygulama içi DM) ------------------------------------------- */

async function loadSocialThreads() {
  const res = await post('socialGetThreads');
  const list = document.getElementById('social-threads-list');
  const empty = document.getElementById('social-threads-empty');
  list.innerHTML = '';
  if (!res || !res.success) return;

  let unreadTotal = 0;
  res.threads.forEach((t) => {
    unreadTotal += Number(t.unread) || 0;
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <img class="social-avatar" src="${socialAvatarSrc(t.avatar, t.username)}" alt="" style="width:52px;height:52px" />
      <div class="row-main">
        <div class="row-title">${esc(t.username)}</div>
        <div class="row-sub">${esc(t.lastBody || '')}</div>
      </div>
      <div class="row-meta">${esc(fmtRelative(t.lastAt))}${Number(t.unread) > 0 ? `<br><span class="unread">${t.unread}</span>` : ''}</div>
    `;
    li.addEventListener('click', () => openSocialChat(t.citizenid, t.username, t.avatar));
    list.appendChild(li);
  });
  empty.hidden = res.threads.length > 0;
  document.getElementById('social-badge-messages').hidden = !unreadTotal;
}

async function openSocialChat(citizenid, username, avatar) {
  State.social.currentChatCitizenid = citizenid;
  State.social.currentChatUsername = username;
  document.getElementById('social-chat-username').textContent = '@' + username;
  document.getElementById('social-chat-avatar').src = socialAvatarSrc(avatar, username);
  document.getElementById('social-chat-input').value = '';
  switchView('social-chat');
  await loadSocialChatMessages();
}

async function loadSocialChatMessages() {
  const citizenid = State.social.currentChatCitizenid;
  if (!citizenid) return;
  const res = await post('socialGetThreadMessages', { citizenid });
  const box = document.getElementById('social-chat-messages');
  box.innerHTML = '';
  if (!res || !res.success) return;
  const mine = res.myCitizenid;
  res.messages.slice().reverse().forEach((m) => box.appendChild(buildSocialChatBubble(m, m.from_citizenid === mine)));
  box.scrollTop = box.scrollHeight;
}

function buildSocialChatBubble(m, out) {
  if (m.shared_post_id) {
    const div = document.createElement('div');
    div.className = 'social-chat-shared' + (out ? '' : ' in');
    if (m.sharedPhoto) {
      div.innerHTML = `
        <div class="social-chat-shared-head">${m.sharedUsername ? esc(m.sharedUsername) : ''}</div>
        <img src="${m.sharedPhoto}" alt="" />
        <div class="social-chat-shared-foot">Gönderiyi gör</div>
      `;
      div.addEventListener('click', () => openSocialPostDetail(m.shared_post_id));
    } else {
      div.innerHTML = '<div class="social-chat-shared-foot">Bu gönderi kaldırıldı</div>';
    }
    return div;
  }
  const bubble = document.createElement('div');
  bubble.className = 'social-chat-bubble ' + (out ? 'out' : 'in');
  bubble.textContent = m.body || '';
  return bubble;
}

document.getElementById('social-chat-back').addEventListener('click', () => {
  switchView('social');
  activateSocialTab('messages');
});

document.getElementById('social-chat-send').addEventListener('click', async () => {
  const input = document.getElementById('social-chat-input');
  const body = input.value.trim();
  if (!body || !State.social.currentChatCitizenid) return;
  const res = await post('socialSendMessage', { to: State.social.currentChatCitizenid, body });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Gönderilemedi.');
  const box = document.getElementById('social-chat-messages');
  box.appendChild(buildSocialChatBubble(res.message, true));
  box.scrollTop = box.scrollHeight;
  input.value = '';
});
document.getElementById('social-chat-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') document.getElementById('social-chat-send').click();
});

/* ---- gönderiyi birine gönder (uçak ikonu) --------------------------------- */

async function openSocialShare(postId) {
  State.social.shareTargetPostId = postId;
  document.getElementById('social-share-search').value = '';
  await renderSocialShareList('');
  openSheet('social-share-sheet');
}

async function renderSocialShareList(query) {
  const res = await post('socialSearchUsers', { query });
  const list = document.getElementById('social-share-list');
  list.innerHTML = '';
  if (!res || !res.success) return;
  res.users.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <img class="social-avatar" src="${socialAvatarSrc(u.avatar, u.username)}" alt="" style="width:38px;height:38px" />
      <div class="row-main"><div class="row-title">${esc(u.username)}</div></div>
    `;
    li.addEventListener('click', async () => {
      const r = await post('socialSendMessage', { to: u.citizenid, sharedPostId: State.social.shareTargetPostId });
      if (r && r.success) { showToast('success', 'Gönderildi.'); closeSheet('social-share-sheet'); }
      else showToast('error', (r && r.reason) || 'Gönderilemedi.');
    });
    list.appendChild(li);
  });
}
document.getElementById('social-share-backdrop').addEventListener('click', () => closeSheet('social-share-sheet'));
let socialShareSearchTimer = null;
document.getElementById('social-share-search').addEventListener('input', (ev) => {
  clearTimeout(socialShareSearchTimer);
  const q = ev.target.value.trim();
  socialShareSearchTimer = setTimeout(() => renderSocialShareList(q), 250);
});

/* ---- yorumlar (sheet) ------------------------------------------------------ */

function buildSocialCommentRow(c) {
  const div = document.createElement('div');
  div.className = 'social-comment-row';
  div.innerHTML = `
    <img class="social-avatar" src="${socialAvatarSrc(c.avatar, c.username)}" alt="" style="width:30px;height:30px" />
    <div class="social-comment-main">
      <div class="social-comment-head"><b>${esc(c.username)}</b><span class="social-comment-time">${esc(fmtRelative(c.ts))}</span></div>
      <div class="social-comment-body">${esc(c.body)}</div>
    </div>
  `;
  return div;
}

async function openSocialComments(postId) {
  State.social.currentPostForComments = postId;
  document.getElementById('social-comment-input').value = '';
  document.getElementById('social-comment-send').disabled = true;
  const res = await post('socialGetComments', { postId });
  const list = document.getElementById('social-comments-list');
  const empty = document.getElementById('social-comments-empty');
  list.innerHTML = '';
  if (res && res.success) {
    res.comments.forEach((c) => list.appendChild(buildSocialCommentRow(c)));
    empty.hidden = res.comments.length > 0;
  }
  openSheet('social-comments-sheet');
}
document.getElementById('social-comments-backdrop').addEventListener('click', () => closeSheet('social-comments-sheet'));
document.getElementById('social-comment-input').addEventListener('input', (ev) => {
  document.getElementById('social-comment-send').disabled = !ev.target.value.trim();
});
document.getElementById('social-comment-send').addEventListener('click', async () => {
  const input = document.getElementById('social-comment-input');
  const body = input.value.trim();
  const postId = State.social.currentPostForComments;
  if (!body || !postId) return;
  const res = await post('socialAddComment', { postId, body });
  if (!res || !res.success) return showToast('error', (res && res.reason) || 'Yorum gönderilemedi.');
  document.getElementById('social-comments-list').appendChild(buildSocialCommentRow(res.comment));
  document.getElementById('social-comments-empty').hidden = true;
  input.value = '';
  document.getElementById('social-comment-send').disabled = true;
  document.querySelectorAll(`.social-post[data-post-id="${postId}"] .social-post-comments-link`).forEach((el) => {
    el.hidden = false;
    el.textContent = `${res.commentCount} yorumun tümünü gör`;
  });
});

/* ---- yeni paylaşım (Gönderi/Hikaye) ---------------------------------------- */

document.getElementById('social-new-post-btn').addEventListener('click', () => {
  State.social.newPostType = 'post';
  State.social.newPostPhoto = null;
  document.querySelectorAll('#social-post-type .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.postType === 'post'));
  document.getElementById('social-post-fields').hidden = false;
  document.getElementById('social-post-caption').value = '';
  document.getElementById('social-post-location').value = '';
  document.getElementById('social-new-post-preview').hidden = true;
  document.getElementById('social-pick-photo-label').hidden = false;
  switchView('social-new-post');
});

document.getElementById('social-post-type').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('#social-post-type .seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  State.social.newPostType = btn.dataset.postType;
  document.getElementById('social-post-fields').hidden = State.social.newPostType === 'story';
});

document.getElementById('social-pick-photo-btn').addEventListener('click', async () => {
  const grid = document.getElementById('social-post-photo-grid');
  const empty = document.getElementById('social-post-photo-empty');
  grid.innerHTML = '';
  let photos = [];
  try { photos = await GalleryDB.listPhotos(); } catch (e) { /* desteklenmiyor olabilir */ }
  empty.hidden = photos.length > 0;
  photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<img src="${p.dataUrl}" alt="" />`;
    div.addEventListener('click', () => {
      closeSheet('social-post-photo-sheet');
      State.social.newPostPhoto = p.dataUrl;
      const preview = document.getElementById('social-new-post-preview');
      preview.src = p.dataUrl;
      preview.hidden = false;
      document.getElementById('social-pick-photo-label').hidden = true;
    });
    grid.appendChild(div);
  });
  openSheet('social-post-photo-sheet');
});
document.getElementById('social-post-photo-backdrop').addEventListener('click', () => closeSheet('social-post-photo-sheet'));

document.getElementById('social-post-submit').addEventListener('click', async () => {
  if (!State.social.newPostPhoto) return showToast('error', 'Önce bir fotoğraf seç.');

  // Galerideki fotoğraf bu güncellemeden önceki eski, sıkıştırılmamış bir çekim
  // olabilir — paylaşım anında burada da sıkıştırıyoruz ki sunucuya giden veri
  // her zaman ağ olayı sınırının (~1 MB) altında kalsın.
  const photo = await compressDataUrl(State.social.newPostPhoto);

  if (State.social.newPostType === 'story') {
    const res = await post('socialCreateStory', { photo });
    if (!res || !res.success) return showToast('error', (res && res.reason) || 'Hikaye paylaşılamadı.');
    showToast('success', 'Hikayen paylaşıldı.');
  } else {
    const caption = document.getElementById('social-post-caption').value.trim();
    const location = document.getElementById('social-post-location').value.trim();
    const res = await post('socialCreatePost', { photo, caption, location });
    if (!res || !res.success) return showToast('error', (res && res.reason) || 'Paylaşılamadı.');
    showToast('success', 'Gönderin paylaşıldı.');
  }

  switchView('social');
  activateSocialTab('feed');
});

/* ------------------------------------------------------------------------ */
/* KAPATMA (ESC)                                                            */
/* ------------------------------------------------------------------------ */

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') {
    document.activeElement.blur();
    return;
  }
  post('close');
  closePhoneUI();
});

renderHomeGrid();
tickClock();

/* ------------------------------------------------------------------------ */
/* LIFEGRAM KÖPRÜSÜ (ayrı resource, iframe)                                  */
/*                                                                           */
/* Lifegram `nui://loe_lifegram/...` kaynağıyla iframe içinde çalışır.    */
/* Oradan doğrudan `https://loe_telephone/...` adresine fetch atmak       */
/* çapraz-köken olur ve CEF bunu engelleyebilir; bu yüzden istekler          */
/* postMessage ile buraya gelir, bu sayfa kendi post() yardımcısıyla NUI      */
/* callback'ini çağırır ve sonucu iframe'e geri yollar.                      */
/*                                                                           */
/* Lifegram'ın kullandığı `social*` aksiyonları client/main.lua'da ZATEN      */
/* kayıtlı (loe_lifegram API'sine gidiyor) — yeni Lua gerekmez.       */
/* ------------------------------------------------------------------------ */

/** Lifegram'ın çağırmasına izin verilen aksiyonlar (beyaz liste). */
const LIFEGRAM_ALLOWED_ACTIONS = new Set([
  'socialGetMe', 'socialRegister', 'socialUpdateProfile',
  'socialGetProfile', 'socialGetProfilePosts', 'socialGetPost',
  'socialGetFeed', 'socialGetExplore', 'socialGetExploreFeed',
  'socialCreatePost', 'socialDeletePost', 'socialToggleLike',
  'socialGetComments', 'socialAddComment', 'socialToggleFollow',
  'socialSearchUsers',
  'socialGetStoriesStrip', 'socialCreateStory', 'socialGetStory', 'socialMarkStorySeen',
  'socialDeleteStory', 'socialLikeStory', 'socialGetStoryViewers',
  'socialGetAlbums', 'socialCreateAlbum', 'socialAddPostToAlbum',
  'socialGetThreads', 'socialGetThreadMessages', 'socialSendMessage',
  'socialToggleSave', 'socialGetSaved',
  'socialGetNotifications', 'socialMarkNotificationsSeen',
  'socialMediaBegin', 'socialMediaChunk', 'socialMediaCommit',
  'socialGetMediaInfo', 'socialGetMediaChunk',
]);

/**
 * Sunucuya gitmeyen, telefonun kendi içinde cevaplanan aksiyonlar.
 * Galeri IndexedDB'de yerel tutuluyor; Lifegram iframe'i farklı bir köken
 * olduğu için oraya doğrudan erişemez, bu yüzden kabuk okuyup gönderir.
 */
/** Lifegram galeri ızgarası küçük kareler ister; her açılışta yeniden küçültmemek için. */
const lifegramThumbs = new Map();

const LIFEGRAM_LOCAL_ACTIONS = {
  /** Fotoğraf + video listesi, yalnızca küçük kareyle (tam veri seçilince istenir). */
  async lifegramGetGallery() {
    const items = (await GalleryDB.list()).slice(0, 60);
    const out = [];
    for (const item of items) {
      let thumb = lifegramThumbs.get(item.id);
      if (!thumb) {
        thumb = await compressDataUrl(item.dataUrl, 320, 0.7);
        lifegramThumbs.set(item.id, thumb);
      }
      out.push({
        id: item.id,
        kind: item.kind === 'video' ? 'video' : 'photo',
        thumb,
        duration: item.duration || 0,
        ts: item.ts,
      });
    }
    return { success: true, items: out };
  },

  /** Seçilen öğenin tamamı. Video Blob olarak gider (postMessage Blob'u kopyalayabilir). */
  async lifegramGetGalleryItem({ id }) {
    const item = await GalleryDB.get(Number(id));
    if (!item) return { success: false, reason: 'Galeri öğesi bulunamadı.' };
    if (item.kind === 'video') {
      return {
        success: true,
        item: { id: item.id, kind: 'video', blob: item.blob, poster: item.dataUrl, duration: item.duration || 0 },
      };
    }
    return { success: true, item: { id: item.id, kind: 'photo', dataUrl: item.dataUrl } };
  },
};

function lifegramFrame() {
  return document.getElementById('lifegram-frame');
}

/** iframe'e mesaj yollar (henüz yüklenmediyse sessizce yok sayar). */
function lifegramPost(payload) {
  const frame = lifegramFrame();
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage(Object.assign({ app: 'lifegram' }, payload), '*');
}

let lifegramReady = false;
let lifegramReadyTimer = null;

function openLifegram() {
  const frame = lifegramFrame();

  // İlk açılışta iframe'i yükle; sonraki açılışlarda yalnızca tazele.
  if (frame && !frame.src && frame.dataset.src) {
    frame.src = frame.dataset.src;
  } else {
    lifegramPost({ action: 'lifegram:refresh' });
  }

  // loe_lifegram başlatılmamışsa iframe hiç yüklenmez ve boş ekran kalır.
  // Uygulama açılışta 'ready' el sıkışması yollar; gelmezse nazikçe geri dön.
  // (loe_lifegram için client/main.lua'daki socialUnavailable ile aynı fikir.)
  clearTimeout(lifegramReadyTimer);
  lifegramReadyTimer = setTimeout(() => {
    if (lifegramReady) return;
    showToast('error', 'Lifegram şu anda kullanılamıyor.');
    switchView('home');
  }, 4000);
}

window.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (!msg || msg.app !== 'lifegram') return;

  // --- uygulama yüklendi ---
  if (msg.kind === 'ready') {
    lifegramReady = true;
    clearTimeout(lifegramReadyTimer);
    return;
  }

  // --- veri isteği (RPC) ---
  if (msg.kind === 'rpc') {
    let res;
    if (LIFEGRAM_LOCAL_ACTIONS[msg.action]) {
      try {
        res = await LIFEGRAM_LOCAL_ACTIONS[msg.action](msg.data || {});
      } catch (err) {
        console.error('[loe_telephone] Lifegram yerel aksiyon hatası:', msg.action, err);
        res = { success: false, reason: 'İşlem başarısız.' };
      }
    } else if (!LIFEGRAM_ALLOWED_ACTIONS.has(msg.action)) {
      console.warn('[loe_telephone] Lifegram izinsiz aksiyon istedi:', msg.action);
      res = { success: false, reason: 'İzin verilmeyen işlem.' };
    } else {
      res = await post(msg.action, msg.data);
    }
    if (ev.source) {
      ev.source.postMessage({ app: 'lifegram', kind: 'rpc-result', id: msg.id, res }, '*');
    }
    return;
  }

  // --- uygulamayı kapat ---
  if (msg.kind === 'close') {
    switchView('home');
    return;
  }

  // --- telefonun kendi bildirim balonu ---
  if (msg.kind === 'toast') {
    showToast(msg.toastKind || 'inform', msg.text || '');
  }
});

