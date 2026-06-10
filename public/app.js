/* Sahara Delivery shared helpers */
const API = {
  token: () => localStorage.getItem('wb_token'),
  user: () => JSON.parse(localStorage.getItem('wb_user') || 'null'),

  async req(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(API.token() ? { Authorization: 'Bearer ' + API.token() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { localStorage.clear(); location.href = '/'; throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  },
  get: (p) => API.req('GET', p),
  post: (p, b) => API.req('POST', p, b),
  patch: (p, b) => API.req('PATCH', p, b),
};

function requireRole(...roles) {
  const u = API.user();
  if (!u || !roles.includes(u.role)) { location.href = '/'; return null; }
  return u;
}

function logout() { localStorage.clear(); location.href = '/'; }

let toastTimer;
function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

const STATUS_LABEL = {
  picking: 'Picking', packed: 'Packed', assigned: 'Assigned',
  in_transit: 'In transit', delivered: 'Delivered', exception: 'Exception',
};

function stamp(status) {
  return `<span class="stamp ${status}">${STATUS_LABEL[status] || status}</span>`;
}

function timeAgo(iso) {
  const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
