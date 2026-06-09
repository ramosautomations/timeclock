const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'timeclock.db'));

const WORK_TYPES = ['Class', 'Front Desk', 'Private Class'];

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    work_type TEXT NOT NULL DEFAULT 'Class',
    clock_in TEXT NOT NULL,
    clock_out TEXT,
    regular_mins INTEGER DEFAULT 0,
    overtime_mins INTEGER DEFAULT 0,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );

  CREATE TABLE IF NOT EXISTS pay_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
  );
`);

// Add work_type column if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE time_entries ADD COLUMN work_type TEXT NOT NULL DEFAULT 'Class'`);
} catch(e) { /* column already exists */ }

// Seed default data if empty
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get();
if (empCount.c === 0) {
  const insert = db.prepare('INSERT INTO employees (name, pin, is_admin) VALUES (?, ?, ?)');
  insert.run('Admin', '0000', 1);
  insert.run('Alex Martinez', '1111', 0);
  insert.run('Sam Chen', '2222', 0);
  insert.run('Jordan Lee', '3333', 0);
  insert.run('Taylor Brooks', '4444', 0);

  const periodInsert = db.prepare('INSERT INTO pay_periods (start_date, end_date) VALUES (?, ?)');
  periodInsert.run('2026-05-29', '2026-06-11');
  periodInsert.run('2026-05-15', '2026-05-28');
  periodInsert.run('2026-05-01', '2026-05-14');
  periodInsert.run('2026-04-17', '2026-04-30');
}

// Generate pay periods (biweekly Fri-Thu, anchor: 2026-05-29)
function getPayPeriods(count = 10) {
  const anchor = new Date('2026-05-29');
  const periods = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - i * 14);
    const end = new Date(start);
    end.setDate(start.getDate() + 13);
    periods.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
  }
  return periods;
}

function calcOvertimeForPeriod(employeeId, periodStart, periodEnd) {
  const entries = db.prepare(`
    SELECT * FROM time_entries
    WHERE employee_id = ? AND clock_in >= ? AND clock_in < date(?, '+1 day') AND clock_out IS NOT NULL
    ORDER BY clock_in
  `).all(employeeId, periodStart, periodEnd);

  const weeklyMins = {};
  entries.forEach(e => {
    const d = new Date(e.clock_in);
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const weekKey = monday.toISOString().slice(0, 10);
    const mins = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000);
    weeklyMins[weekKey] = (weeklyMins[weekKey] || 0) + mins;
  });

  let totalRegular = 0, totalOvertime = 0;
  Object.values(weeklyMins).forEach(mins => {
    totalRegular += Math.min(mins, 2400);
    totalOvertime += Math.max(0, mins - 2400);
  });
  return { totalRegular, totalOvertime };
}

// ---- API ROUTES ----

app.post('/api/login', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE pin = ?').get(req.body.pin);
  if (!emp) return res.status(401).json({ error: 'Invalid PIN' });
  res.json({ id: emp.id, name: emp.name, is_admin: emp.is_admin });
});

app.get('/api/employees', (req, res) => {
  res.json(db.prepare('SELECT id, name, is_admin FROM employees ORDER BY name').all());
});

app.post('/api/employees', (req, res) => {
  const { name, pin, is_admin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  if (db.prepare('SELECT id FROM employees WHERE pin = ?').get(pin)) return res.status(400).json({ error: 'PIN already in use' });
  const isAdminInt = is_admin ? 1 : 0;
  const result = db.prepare('INSERT INTO employees (name, pin, is_admin) VALUES (?, ?, ?)').run(name, pin, isAdminInt);
  res.json({ id: result.lastInsertRowid, name, is_admin: isAdminInt });
});

app.put('/api/employees/:id', (req, res) => {
  const { name, is_admin } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const isAdminInt = is_admin ? 1 : 0;
  db.prepare('UPDATE employees SET name = ?, is_admin = ? WHERE id = ?').run(name, isAdminInt, req.params.id);
  res.json({ ok: true, id: req.params.id, name, is_admin: isAdminInt });
});

app.put('/api/employees/:id/pin', (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  if (db.prepare('SELECT id FROM employees WHERE pin = ? AND id != ?').get(pin, req.params.id)) return res.status(400).json({ error: 'PIN already in use' });
  db.prepare('UPDATE employees SET pin = ? WHERE id = ?').run(pin, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/employees/:id', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(req.params.id);
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Clock status — returns open entry if any
app.get('/api/status/:employeeId', (req, res) => {
  const open = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(req.params.employeeId);
  res.json({ clocked_in: !!open, entry: open || null });
});

// Clock in — requires work_type
app.post('/api/clockin', (req, res) => {
  const { employee_id, work_type } = req.body;
  if (!WORK_TYPES.includes(work_type)) return res.status(400).json({ error: 'Invalid work type' });
  const open = db.prepare('SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(employee_id);
  if (open) return res.status(400).json({ error: 'Already clocked in' });
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO time_entries (employee_id, work_type, clock_in) VALUES (?, ?, ?)').run(employee_id, work_type, now);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid));
});

// Clock out
app.post('/api/clockout', (req, res) => {
  const { employee_id } = req.body;
  const open = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(employee_id);
  if (!open) return res.status(400).json({ error: 'Not clocked in' });
  const now = new Date();
  const totalMins = Math.round((now - new Date(open.clock_in)) / 60000);
  const regular = Math.min(totalMins, 480);
  const overtime = Math.max(0, totalMins - 480);
  db.prepare(`UPDATE time_entries SET clock_out = ?, regular_mins = ?, overtime_mins = ? WHERE id = ?`).run(now.toISOString(), regular, overtime, open.id);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id));
});

// Today's log — returns last 36 hours so timezone offsets never cause missed entries
// Frontend filters to local date
app.get('/api/today/:employeeId', (req, res) => {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  res.json(db.prepare(`
    SELECT * FROM time_entries
    WHERE employee_id = ? AND clock_in >= ?
    ORDER BY clock_in
  `).all(req.params.employeeId, since));
});

app.get('/api/payperiods', (req, res) => res.json(getPayPeriods(12)));

// Admin report — includes per-type breakdown
app.get('/api/report', (req, res) => {
  const { start, end, employee_id } = req.query;
  let emps = db.prepare('SELECT id, name FROM employees WHERE is_admin = 0 ORDER BY name').all();
  if (employee_id) emps = emps.filter(e => e.id == employee_id);

  const report = emps.map(emp => {
    const entries = db.prepare(`
      SELECT * FROM time_entries
      WHERE employee_id = ? AND clock_in >= ? AND clock_in < date(?, '+1 day')
      ORDER BY clock_in
    `).all(emp.id, start, end);

    let totalMins = 0;
    const days = new Set();
    const byType = {};
    WORK_TYPES.forEach(t => { byType[t] = 0; });

    entries.forEach(e => {
      if (e.clock_out) {
        const mins = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000);
        totalMins += mins;
        days.add(e.clock_in.slice(0, 10));
        const t = e.work_type || 'Class';
        byType[t] = (byType[t] || 0) + mins;
      }
    });

    const { totalRegular, totalOvertime } = calcOvertimeForPeriod(emp.id, start, end);

    return {
      employee: emp,
      totalMins,
      totalRegular,
      totalOvertime,
      byType,
      days: days.size,
      entries: entries.map(e => ({
        ...e,
        durationMins: e.clock_out ? Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000) : null
      }))
    };
  });

  res.json(report);
});

// Admin: get entries for employee
app.get('/api/entries/:employeeId', (req, res) => {
  const { start, end } = req.query;
  let sql = `SELECT * FROM time_entries WHERE employee_id = ?`;
  const params = [req.params.employeeId];
  if (start && end) { sql += ` AND clock_in >= ? AND clock_in < date(?, '+1 day')`; params.push(start, end); }
  sql += ` ORDER BY clock_in DESC`;
  res.json(db.prepare(sql).all(...params));
});

// Admin: add manual entry
app.post('/api/entries', (req, res) => {
  const { employee_id, work_type, clock_in, clock_out } = req.body;
  if (!employee_id || !clock_in) return res.status(400).json({ error: 'employee_id and clock_in required' });
  if (!WORK_TYPES.includes(work_type)) return res.status(400).json({ error: 'Invalid work type' });
  if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  let regular_mins = 0, overtime_mins = 0;
  if (clock_out) {
    const totalMins = Math.round((new Date(clock_out) - new Date(clock_in)) / 60000);
    regular_mins = Math.min(totalMins, 480);
    overtime_mins = Math.max(0, totalMins - 480);
  }
  const result = db.prepare(`INSERT INTO time_entries (employee_id, work_type, clock_in, clock_out, regular_mins, overtime_mins) VALUES (?, ?, ?, ?, ?, ?)`).run(employee_id, work_type, clock_in, clock_out || null, regular_mins, overtime_mins);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid));
});

// Admin: edit entry
app.put('/api/entries/:id', (req, res) => {
  const { work_type, clock_in, clock_out } = req.body;
  if (!clock_in) return res.status(400).json({ error: 'clock_in required' });
  if (!WORK_TYPES.includes(work_type)) return res.status(400).json({ error: 'Invalid work type' });
  if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  let regular_mins = 0, overtime_mins = 0;
  if (clock_out) {
    const totalMins = Math.round((new Date(clock_out) - new Date(clock_in)) / 60000);
    regular_mins = Math.min(totalMins, 480);
    overtime_mins = Math.max(0, totalMins - 480);
  }
  db.prepare(`UPDATE time_entries SET work_type=?, clock_in=?, clock_out=?, regular_mins=?, overtime_mins=? WHERE id=?`).run(work_type, clock_in, clock_out || null, regular_mins, overtime_mins, req.params.id);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id=?').get(req.params.id));
});

// Admin: delete entry
app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TimeClock running on http://localhost:${PORT}`));