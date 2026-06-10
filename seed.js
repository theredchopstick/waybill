const bcrypt = require('bcryptjs');
const { db, genRef } = require('./db');

const hash = (p) => bcrypt.hashSync(p, 10);

const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (existing.n > 0) {
  console.log('Database already seeded — delete waybill.db to reseed.');
  process.exit(0);
}

const wh = db.prepare('INSERT INTO warehouses (code, name, region) VALUES (?,?,?)');
const w1 = wh.run('NTH', 'North Depot', 'Northside').lastInsertRowid;
const w2 = wh.run('STH', 'South Depot', 'Docklands').lastInsertRowid;
const w3 = wh.run('CTR', 'Central Hub', 'City Centre').lastInsertRowid;

const u = db.prepare('INSERT INTO users (username, password_hash, role, display_name, warehouse_id) VALUES (?,?,?,?,?)');
u.run('admin', hash('admin123'), 'admin', 'Site Admin', null);
u.run('ops1', hash('ops123'), 'warehouse', 'Riley (Ops)', w1);
u.run('ops2', hash('ops123'), 'warehouse', 'Morgan (Ops)', w2);
const d1 = u.run('driver1', hash('drive123'), 'driver', 'Alex T.', null).lastInsertRowid;
const d2 = u.run('driver2', hash('drive123'), 'driver', 'Sam K.', null).lastInsertRowid;
const d3 = u.run('driver3', hash('drive123'), 'driver', 'Jordan P.', null).lastInsertRowid;

const ord = db.prepare('INSERT INTO orders (ref, customer, destination, items, priority, warehouse_id, status) VALUES (?,?,?,?,?,?,?)');
const job = db.prepare('INSERT INTO jobs (ref, order_id, warehouse_id, driver_id, status) VALUES (?,?,?,?,?)');

const demo = [
  ['PlayerOne', 'Sandy Shores garage', '3x engine parts, 1x toolkit', 'express', w1, 'dispatched', d1, 'in_transit'],
  ['CrewBoss_99', 'Paleto Bay store', '12x crates of supplies', 'standard', w1, 'processing', null, 'picking'],
  ['x_Nova_x', 'Vinewood apartment 22', '1x furniture set', 'standard', w3, 'processing', null, 'packed'],
  ['Trucker_Dan', 'Grapeseed farm', '6x feed bags, 2x fence kits', 'standard', w2, 'dispatched', d2, 'assigned'],
  ['MikeRP', 'Del Perro pier shop', '4x electronics boxes', 'express', w3, 'complete', d3, 'delivered'],
  ['LunaGames', 'Mirror Park house', '2x appliance crates', 'standard', w1, 'complete', d1, 'delivered'],
  ['Vex', 'Harmony depot', '8x fuel cans', 'express', w2, 'processing', d2, 'exception'],
];

for (const [customer, dest, items, prio, whId, ostatus, driverId, jstatus] of demo) {
  const oRef = genRef('ORD');
  const oid = ord.run(oRef, customer, dest, items, prio, whId, ostatus).lastInsertRowid;
  const jRef = genRef('JOB');
  const jid = job.run(jRef, oid, whId, driverId, jstatus).lastInsertRowid;
  db.prepare('INSERT INTO events (job_id, order_id, type, message) VALUES (?,?,?,?)')
    .run(jid, oid, 'job_created', `Job ${jRef} created for order ${oRef}`);
}
db.prepare("UPDATE jobs SET notes = 'Road blocked at the tunnel, rerouting needed' WHERE status = 'exception'").run();

console.log('Seeded. Demo accounts:');
console.log('  admin   / admin123   (admin panel)');
console.log('  ops1    / ops123     (warehouse — North Depot)');
console.log('  ops2    / ops123     (warehouse — South Depot)');
console.log('  driver1 / drive123   (driver app)');
console.log('  driver2 / drive123   (driver app)');
console.log('  driver3 / drive123   (driver app)');
