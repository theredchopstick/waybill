// Tiny .env loader (no dependency needed)
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)?\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
    });
} catch {}
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, genRef, getSetting, setSetting, getOrCreateSecret } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = getOrCreateSecret();

// Config reads DB settings first (editable in the admin Settings tab),
// then falls back to environment variables. No restart needed after edits.
const cfg = {
  dispatch:  () => getSetting('webhook_dispatch', process.env.DISCORD_WEBHOOK_DISPATCH || ''),
  alerts:    () => getSetting('webhook_alerts', process.env.DISCORD_WEBHOOK_ALERTS || '') || cfg.dispatch(),
  customer:  () => getSetting('webhook_customer', process.env.DISCORD_WEBHOOK_CUSTOMER || ''),
  publicUrl: () => getSetting('public_url', process.env.PUBLIC_URL || ''),
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

/* ---------- Discord notifications (fire and forget) ---------- */
const STATUS_COLORS = {
  picking: 0xb45309, packed: 0x6d28d9, assigned: 0x0369a1,
  in_transit: 0xd97706, out_for_delivery: 0xe8590c,
  attempted: 0x9a3412, delivered: 0x15803d,
  exception: 0xb91c1c, lost: 0x7f1d1d, returned: 0x44403c,
  rerouted: 0x0369a1,
};
const STATUS_LABELS = {
  picking: 'Picking', packed: 'Packed', assigned: 'Assigned',
  in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  attempted: 'Delivery attempted', delivered: 'Delivered',
  exception: 'Exception', lost: 'Lost in transit', returned: 'Returned to depot',
  rerouted: 'Rerouted',
};

function notifyDiscord(webhookUrl, { title, description, color, fields }) {
  if (!webhookUrl) return;
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title, description, color: color || 0x5f5e5a,
        fields: fields || [],
        timestamp: new Date().toISOString(),
        footer: { text: 'Sahara Delivery' },
      }],
    }),
  }).catch((e) => console.error('Discord notify failed:', e.message));
}

function notifyJobEvent(job, actorName, extra = '') {
  const isAlert = ['exception', 'lost', 'attempted'].includes(job.status);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(job.order_id);
  const driver = job.driver_id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(job.driver_id) : null;
  notifyDiscord(isAlert ? cfg.alerts() : cfg.dispatch(), {
    title: `${isAlert ? '⚠️ ' : ''}${job.ref} — ${STATUS_LABELS[job.status]}`,
    description: extra || `Order ${order?.ref} · ${order?.destination || ''}`,
    color: STATUS_COLORS[job.status],
    fields: [
      { name: 'Driver', value: driver?.display_name || 'Unassigned', inline: true },
      { name: 'By', value: actorName, inline: true },
    ],
  });
}

/* ---------- Customer-facing notifications (player-friendly) ---------- */
const CUSTOMER_MILESTONES = {
  received:    { title: '📦 Order received',        color: 0x534ab7, body: (o)       => `We've got your order and it's in the queue.` },
  preparing:   { title: '🔧 Preparing your order',  color: 0xb45309, body: (o)       => `Our team is picking and packing your items.` },
  out:         { title: '🚚 Out for delivery',       color: 0xe8590c, body: (o, d)    => `${d ? d + ' is' : 'A driver is'} on the way to ${o.destination}.` },
  delivered:   { title: '✅ Delivered',              color: 0x15803d, body: (o)       => `Your order has arrived at ${o.destination}. Enjoy!` },
  attempted:   { title: '🔔 Delivery attempted',    color: 0x9a3412, body: (o, d, n) => `${d || 'Your driver'} tried to deliver but couldn't complete it${n ? ': ' + n : '.'} Dispatch is arranging another attempt.` },
  delayed:     { title: '⏳ Delivery delayed',       color: 0xb91c1c, body: (o, d, n) => n ? `Heads up: ${n}` : `There's a short delay on your order. We're on it.` },
  lost:        { title: '❌ Item lost in transit',   color: 0x7f1d1d, body: (o)       => `We're sorry — your order can't be located. Please contact staff with your order code.` },
  returned:    { title: '↩️ Order returned to depot', color: 0x44403c, body: (o)      => `Your order has been returned to the depot. Please contact staff to rearrange delivery.` },
  rerouted:    { title: '🔄 Order rerouted',          color: 0x0369a1, body: (o, d, n) => n || `Your order has been redirected to a different depot and will continue from there.` },
};

function notifyCustomer(milestone, order, { driverName, note } = {}) {
  const customerHook = cfg.customer();
  if (!customerHook) return;
  const m = CUSTOMER_MILESTONES[milestone];
  if (!m) return;
  const pub = cfg.publicUrl();
  const trackLine = pub ? `\n\n🔎 Track it: ${pub.replace(/\/$/, '')}/track.html?ref=${order.ref}` : '';
  notifyDiscord(customerHook, {
    title: m.title,
    description: `**${order.customer}** — order \`${order.ref}\`\n${m.body(order, driverName, note)}${trackLine}`,
    color: m.color,
  });
}

/* ---------- Auth ---------- */
function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.display_name, warehouse_id: user.warehouse_id },
    JWT_SECRET, { expiresIn: '12h' }
  );
}

function auth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch {
      res.status(401).json({ error: 'Not signed in' });
    }
  };
}

function logEvent({ job_id = null, order_id = null, actor_id = null, type, message }) {
  db.prepare('INSERT INTO events (job_id, order_id, actor_id, type, message) VALUES (?,?,?,?,?)')
    .run(job_id, order_id, actor_id, type, message);
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get((username || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  res.json({ token: sign(user), user: { id: user.id, role: user.role, name: user.display_name } });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

/* ---------- Warehouses ---------- */
app.get('/api/warehouses', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM warehouses ORDER BY code').all());
});

app.post('/api/warehouses', auth('admin'), (req, res) => {
  const { code, name, region } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });
  try {
    const r = db.prepare('INSERT INTO warehouses (code, name, region) VALUES (?,?,?)')
      .run(code.toUpperCase().trim(), name.trim(), (region || '').trim());
    res.json(db.prepare('SELECT * FROM warehouses WHERE id = ?').get(r.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'Warehouse code already exists' });
  }
});

/* ---------- Users ---------- */
app.get('/api/users', auth('admin', 'warehouse'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.role, u.display_name, u.warehouse_id, u.active, u.created_at, w.code AS warehouse_code
    FROM users u LEFT JOIN warehouses w ON w.id = u.warehouse_id ORDER BY u.role, u.display_name
  `).all();
  res.json(rows);
});

app.get('/api/drivers', auth('warehouse', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.display_name,
      (SELECT COUNT(*) FROM jobs j WHERE j.driver_id = u.id AND j.status IN ('assigned','in_transit')) AS active_jobs
    FROM users u WHERE u.role = 'driver' AND u.active = 1 ORDER BY active_jobs, u.display_name
  `).all();
  res.json(rows);
});

app.post('/api/users', auth('admin'), (req, res) => {
  const { username, password, role, display_name, warehouse_id } = req.body || {};
  if (!username || !password || !role || !display_name) {
    return res.status(400).json({ error: 'Username, password, role and display name are required' });
  }
  if (!['driver', 'warehouse', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, role, display_name, warehouse_id) VALUES (?,?,?,?,?)')
      .run(username.toLowerCase().trim(), bcrypt.hashSync(password, 10), role, display_name.trim(), warehouse_id || null);
    res.json({ id: r.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Username already taken' });
  }
});

app.patch('/api/users/:id', auth('admin'), (req, res) => {
  const { active, password } = req.body || {};
  if (typeof active === 'number' || typeof active === 'boolean') {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  res.json({ ok: true });
});

/* ---------- Orders ---------- */
app.get('/api/orders', auth(), (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, w.code AS warehouse_code,
      (SELECT COUNT(*) FROM jobs j WHERE j.order_id = o.id) AS job_count
    FROM orders o JOIN warehouses w ON w.id = o.warehouse_id
    ORDER BY o.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

app.post('/api/orders', auth('warehouse', 'admin'), (req, res) => {
  const { customer, destination, items, priority, warehouse_id } = req.body || {};
  if (!customer || !destination || !items || !warehouse_id) {
    return res.status(400).json({ error: 'Customer, destination, items and warehouse are required' });
  }
  const ref = genRef('ORD');
  const r = db.prepare('INSERT INTO orders (ref, customer, destination, items, priority, warehouse_id, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(ref, customer.trim(), destination.trim(), items.trim(), priority === 'express' ? 'express' : 'standard', warehouse_id, req.user.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
  logEvent({ order_id: order.id, actor_id: req.user.id, type: 'order_created', message: `Order ${ref} created for ${customer}` });
  notifyDiscord(cfg.dispatch(), {
    title: `📦 New order ${ref}`,
    description: `${customer} → ${destination}`,
    color: 0x534ab7,
    fields: [{ name: 'Priority', value: priority === 'express' ? 'Express' : 'Standard', inline: true }],
  });
  notifyCustomer('received', order);
  res.json(order);
});

/* ---------- Public depots (for the order form dropdown) ---------- */
app.get('/api/public/depots', (req, res) => {
  res.json(db.prepare('SELECT id, code, name, region FROM warehouses ORDER BY code').all());
});

/* ---------- Public order submission (no auth) ---------- */
// Simple in-memory rate limit: max 5 orders per IP per 10 minutes.
const orderHits = new Map();
const ORDER_WINDOW_MS = 10 * 60 * 1000;
const ORDER_MAX = 5;
function rateLimited(ip) {
  const now = Date.now();
  const hits = (orderHits.get(ip) || []).filter((t) => now - t < ORDER_WINDOW_MS);
  if (hits.length >= ORDER_MAX) { orderHits.set(ip, hits); return true; }
  hits.push(now);
  orderHits.set(ip, hits);
  return false;
}
function clip(s, max) { return String(s || '').trim().slice(0, max); }

app.post('/api/order', (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "You've placed a lot of orders recently — give it a few minutes and try again." });
  }
  const customer = clip(req.body?.customer, 40);
  const destination = clip(req.body?.destination, 100);
  const items = clip(req.body?.items, 600);
  const warehouse_id = +req.body?.warehouse_id;
  if (!customer || !destination || !items || !warehouse_id) {
    return res.status(400).json({ error: 'Please fill in your name, destination, items and a depot.' });
  }
  const depot = db.prepare('SELECT id FROM warehouses WHERE id = ?').get(warehouse_id);
  if (!depot) return res.status(400).json({ error: 'Pick a depot from the list.' });

  const ref = genRef('ORD');
  // Public orders are always standard priority; staff can bump to express on the board.
  const r = db.prepare('INSERT INTO orders (ref, customer, destination, items, priority, warehouse_id, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(ref, customer, destination, items, 'standard', warehouse_id, null);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
  logEvent({ order_id: order.id, type: 'order_created', message: `Order ${ref} submitted by ${customer} (self-service)` });
  notifyDiscord(cfg.dispatch(), {
    title: `📥 New order ${ref} (self-service)`,
    description: `${customer} → ${destination}`,
    color: 0x534ab7,
    fields: [{ name: 'Items', value: items.slice(0, 200), inline: false }],
  });
  notifyCustomer('received', order);
  // Only return what the player needs — their tracking code.
  res.json({ ref: order.ref, destination: order.destination });
});

/* ---------- Jobs ---------- */
const JOB_FLOW = {
  picking: 'packed',
  packed: 'assigned',
  assigned: 'in_transit',
  in_transit: 'out_for_delivery',
  out_for_delivery: 'delivered',
};

app.get('/api/jobs', auth(), (req, res) => {
  let where = '1=1';
  const params = [];
  if (req.user.role === 'driver') { where = 'j.driver_id = ?'; params.push(req.user.id); }
  else if (req.query.status) { where = 'j.status = ?'; params.push(req.query.status); }
  const rows = db.prepare(`
    SELECT j.*, o.ref AS order_ref, o.customer, o.destination, o.items, o.priority,
           w.code AS warehouse_code, w.name AS warehouse_name, u.display_name AS driver_name
    FROM jobs j
    JOIN orders o ON o.id = j.order_id
    JOIN warehouses w ON w.id = j.warehouse_id
    LEFT JOIN users u ON u.id = j.driver_id
    WHERE ${where} ORDER BY j.updated_at DESC LIMIT 200
  `).all(...params);
  res.json(rows);
});

app.post('/api/jobs', auth('warehouse', 'admin'), (req, res) => {
  const { order_id } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const ref = genRef('JOB');
  const r = db.prepare('INSERT INTO jobs (ref, order_id, warehouse_id) VALUES (?,?,?)').run(ref, order.id, order.warehouse_id);
  db.prepare("UPDATE orders SET status = 'processing' WHERE id = ?").run(order.id);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(r.lastInsertRowid);
  logEvent({ job_id: job.id, order_id: order.id, actor_id: req.user.id, type: 'job_created', message: `Job ${ref} created — picking started` });
  notifyJobEvent(job, req.user.name, `Picking started for order ${order.ref}`);
  notifyCustomer('preparing', order);
  res.json(job);
});

app.patch('/api/jobs/:id/assign', auth('warehouse', 'admin'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const assignableFrom = ['packed', 'attempted', 'returned'];
  if (!assignableFrom.includes(job.status)) return res.status(400).json({ error: `Can't reassign from status: ${job.status}` });
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver' AND active = 1").get(req.body?.driver_id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  db.prepare("UPDATE jobs SET driver_id = ?, status = 'assigned', updated_at = datetime('now') WHERE id = ?").run(driver.id, job.id);
  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  logEvent({ job_id: job.id, order_id: job.order_id, actor_id: req.user.id, type: 'job_assigned', message: `${job.ref} assigned to ${driver.display_name}` });
  notifyJobEvent(updated, req.user.name);
  res.json(updated);
});

app.patch('/api/jobs/:id/status', auth(), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, note } = req.body || {};

  // Permission rules
  if (req.user.role === 'driver') {
    if (job.driver_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
    const driverAllowed =
      (job.status === 'assigned'          && status === 'in_transit')       ||
      (job.status === 'in_transit'        && status === 'out_for_delivery') ||
      (job.status === 'out_for_delivery'  && status === 'delivered')        ||
      (job.status === 'out_for_delivery'  && status === 'attempted')        ||
      (['in_transit','out_for_delivery'].includes(job.status) && status === 'lost') ||
      status === 'exception';
    if (!driverAllowed) return res.status(400).json({ error: 'That status change isn\'t allowed from your current step' });
  } else {
    const recoverable = ['exception', 'attempted', 'lost', 'returned', 'rerouted'];
    const valid = JOB_FLOW[job.status] === status
      || status === 'exception'
      || status === 'lost'
      || status === 'returned'
      || (recoverable.includes(job.status) && ['picking', 'packed', 'assigned', 'in_transit', 'out_for_delivery'].includes(status));
    if (!valid) return res.status(400).json({ error: `Can't move from ${job.status} to ${status}` });
    if (status === 'assigned' && !job.driver_id) return res.status(400).json({ error: 'Assign a driver first' });
  }

  db.prepare("UPDATE jobs SET status = ?, notes = CASE WHEN ? != '' THEN ? ELSE notes END, updated_at = datetime('now') WHERE id = ?")
    .run(status, note || '', note || '', job.id);
  if (status === 'delivered') {
    db.prepare("UPDATE orders SET status = 'complete' WHERE id = ?").run(job.order_id);
  } else if (status === 'returned') {
    db.prepare("UPDATE orders SET status = 'received' WHERE id = ?").run(job.order_id);
  } else if (['in_transit', 'out_for_delivery'].includes(status)) {
    db.prepare("UPDATE orders SET status = 'dispatched' WHERE id = ?").run(job.order_id);
  }
  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  logEvent({
    job_id: job.id, order_id: job.order_id, actor_id: req.user.id,
    type: `job_${status}`, message: `${job.ref} → ${STATUS_LABELS[status]}${note ? ` — ${note}` : ''}`,
  });
  notifyJobEvent(updated, req.user.name, note || '');

  // Customer milestones
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(job.order_id);
  const driverName = updated.driver_id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(updated.driver_id)?.display_name : null;
  if (status === 'out_for_delivery') notifyCustomer('out', order, { driverName });
  else if (status === 'delivered')       notifyCustomer('delivered', order);
  else if (status === 'attempted')       notifyCustomer('attempted', order, { driverName, note });
  else if (status === 'exception')       notifyCustomer('delayed', order, { note });
  else if (status === 'lost')            notifyCustomer('lost', order);
  else if (status === 'returned')        notifyCustomer('returned', order);
  else if (status === 'rerouted')        notifyCustomer('rerouted', order, { note });

  res.json(updated);
});

/* ---------- Public order tracking (no auth) ---------- */
// Customer-safe stage names
const PUBLIC_STAGE = {
  picking: 'preparing', packed: 'preparing', assigned: 'preparing',
  in_transit: 'out', out_for_delivery: 'out',
  attempted: 'attempted', delivered: 'delivered',
  exception: 'delayed', lost: 'lost', returned: 'returned',
  rerouted: 'rerouted',
};

// Customer-safe event labels — never expose internal job mechanics
const PUBLIC_EVENT_LABEL = {
  order_created:  'Order received',
  job_created:    'Preparing your order',
  job_packed:     'Order packed and ready',
  job_assigned:   'Driver assigned',
  job_in_transit: 'On the way',
  job_out_for_delivery: 'Out for delivery',
  job_attempted:  'Delivery attempted',
  job_delivered:  'Delivered',
  job_exception:  'Update from dispatch',
  job_lost:       'Issue reported',
  job_returned:   'Returned to depot',
  job_rerouted:   'Order rerouted to new depot',
};

app.get('/api/track/:ref', (req, res) => {
  const ref = (req.params.ref || '').toUpperCase().trim();
  const order = db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
  if (!order) return res.status(404).json({ error: "We couldn't find an order with that code." });

  const job = db.prepare('SELECT * FROM jobs WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id);
  let stage = 'received';
  let statusNote = '';
  let depot = null;
  if (job) {
    stage = PUBLIC_STAGE[job.status] || 'received';
    if (['exception','attempted','lost','returned','rerouted'].includes(job.status)) statusNote = job.notes || '';
    const w = db.prepare('SELECT name, region FROM warehouses WHERE id = ?').get(job.warehouse_id);
    depot = w ? `${w.name}${w.region ? ' · ' + w.region : ''}` : null;
  }

  // Full event history for this order — customer-safe labels only
  const events = db.prepare(`
    SELECT e.type, e.message, e.created_at,
           CASE WHEN e.type IN ('job_exception','job_attempted','job_lost','job_returned','job_rerouted') THEN e.message ELSE '' END AS public_note
    FROM events e
    WHERE e.order_id = ?
    ORDER BY e.created_at ASC
  `).all(order.id).map(e => ({
    label: PUBLIC_EVENT_LABEL[e.type] || null,
    note: e.public_note || '',
    at: e.created_at,
  })).filter(e => e.label); // drop internal events with no customer label

  res.json({
    ref: order.ref,
    customer: order.customer,
    destination: order.destination,
    items: order.items,
    priority: order.priority,
    depot,
    stage,
    statusNote,
    placed_at: order.created_at,
    updated_at: job?.updated_at || order.created_at,
    events,
  });
});

/* ---------- Reroute job to different depot (warehouse/admin) ---------- */
app.patch('/api/jobs/:id/reroute', auth('warehouse', 'admin'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const rerouteable = ['picking','packed','assigned','in_transit','out_for_delivery','attempted','returned','exception'];
  if (!rerouteable.includes(job.status)) return res.status(400).json({ error: `Can't reroute a job that is ${job.status}` });

  const depot = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.body?.warehouse_id);
  if (!depot) return res.status(400).json({ error: 'Depot not found' });
  if (depot.id === job.warehouse_id) return res.status(400).json({ error: 'Job is already at that depot' });

  const oldDepot = db.prepare('SELECT code FROM warehouses WHERE id = ?').get(job.warehouse_id);
  const note = req.body?.note || `Rerouted from ${oldDepot?.code} to ${depot.code}`;

  db.prepare(`UPDATE jobs SET warehouse_id = ?, status = 'rerouted', driver_id = NULL,
    notes = ?, updated_at = datetime('now') WHERE id = ?`).run(depot.id, note, job.id);
  db.prepare("UPDATE orders SET warehouse_id = ? WHERE id = ?").run(depot.id, job.order_id);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(job.order_id);

  logEvent({ job_id: job.id, order_id: job.order_id, actor_id: req.user.id,
    type: 'job_rerouted', message: note });
  notifyJobEvent(updated, req.user.name, note);
  notifyCustomer('rerouted', order, { note });

  res.json(updated);
});

/* ---------- Settings (admin) ---------- */
const SETTING_KEYS = ['webhook_dispatch', 'webhook_alerts', 'webhook_customer', 'public_url'];

app.get('/api/settings', auth('admin'), (req, res) => {
  // Report current effective values + whether each is locked by an env var.
  const envMap = {
    webhook_dispatch: 'DISCORD_WEBHOOK_DISPATCH', webhook_alerts: 'DISCORD_WEBHOOK_ALERTS',
    webhook_customer: 'DISCORD_WEBHOOK_CUSTOMER', public_url: 'PUBLIC_URL',
  };
  const out = {};
  for (const k of SETTING_KEYS) {
    out[k] = { value: getSetting(k, ''), envLocked: !!process.env[envMap[k]] };
  }
  res.json(out);
});

app.put('/api/settings', auth('admin'), (req, res) => {
  for (const k of SETTING_KEYS) {
    if (typeof req.body?.[k] === 'string') setSetting(k, req.body[k].trim());
  }
  res.json({ ok: true });
});

app.post('/api/settings/test', auth('admin'), async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return res.status(400).json({ error: 'That doesn\'t look like a Discord webhook URL.' });
  }
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: '✅ Waybill connected', description: 'This channel will receive updates.', color: 0x2f7d4f }] }),
    });
    if (!r.ok) return res.status(400).json({ error: `Discord rejected it (HTTP ${r.status}). Double-check the URL.` });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Could not reach Discord. Check the URL and try again.' });
  }
});

/* ---------- Events + stats ---------- */
app.get('/api/events', auth(), (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, u.display_name AS actor_name, j.ref AS job_ref
    FROM events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN jobs j ON j.id = e.job_id
    ORDER BY e.created_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

app.get('/api/stats', auth('admin', 'warehouse'), (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
  const today = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE date(created_at) = date('now')").get();
  const deliveredToday = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='delivered' AND date(updated_at) = date('now')").get();
  const exceptions = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='exception'").get();
  const activeDrivers = db.prepare("SELECT COUNT(DISTINCT driver_id) AS n FROM jobs WHERE status IN ('assigned','in_transit')").get();
  const topDrivers = db.prepare(`
    SELECT u.display_name, COUNT(*) AS delivered FROM jobs j JOIN users u ON u.id = j.driver_id
    WHERE j.status = 'delivered' GROUP BY j.driver_id ORDER BY delivered DESC LIMIT 5
  `).all();
  const perWarehouse = db.prepare(`
    SELECT w.code, COUNT(*) AS jobs FROM jobs j JOIN warehouses w ON w.id = j.warehouse_id GROUP BY w.id ORDER BY jobs DESC
  `).all();
  res.json({
    byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.n])),
    jobsToday: today.n, deliveredToday: deliveredToday.n,
    openExceptions: exceptions.n, activeDrivers: activeDrivers.n,
    topDrivers, perWarehouse,
  });
});

/* ---------- First-run bootstrap ---------- */
// If there are no users yet, create an admin so you can sign in immediately.
function firstRun() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;
  const pass = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
    .run('admin', bcrypt.hashSync(pass, 10), 'admin', 'Site Admin');
  console.log('\n========================================');
  console.log('  First run — admin account created');
  console.log('  username: admin');
  console.log('  password: ' + pass);
  console.log('  Change it in the admin panel after signing in.');
  console.log('========================================\n');
}

firstRun();
app.listen(PORT, () => console.log(`Sahara Delivery running on http://localhost:${PORT}`));
