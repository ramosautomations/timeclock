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

// Seed default data if empty
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get();
if (empCount.c === 0) {
  const insert = db.prepare('INSERT INTO employees (name, pin, is_admin) VALUES (?, ?, ?)');
  insert.run('Admin', '0000', 1);
  insert.run('Alex Martinez', '1111', 0);
  insert.run('Sam Chen', '2222', 0);
  insert.run('Jordan Lee', '3333', 0);
  insert.run('Taylor Brooks', '4444', 0);

  // Seed pay periods starting Jun 1 2026 going back
  const periodInsert = db.prepare('INSERT INTO pay_periods (start_date, end_date) VALUES (?, ?)');
  periodInsert.run('2026-05-29', '2026-06-11');
  periodInsert.run('2026-05-15', '2026-05-28');
  periodInsert.run('2026-05-01', '2026-05-14');
  periodInsert.run('2026-04-17', '2026-04-30');
}

// Generate pay periods dynamically (biweekly Fri-Thu, anchor: 2026-05-29)
function getPayPeriods(count = 10) {
  const anchor = new Date('2026-05-29'); // Friday May 29 2026
  const periods = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - i * 14);
    const end = new Date(start);
    end.setDate(start.getDate() + 13); // 14 days: Fri to Thu
    periods.push({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10)
    });
  }
  return periods;
}

function calcOvertimeForPeriod(employeeId, periodStart, periodEnd) {
  const entries = db.prepare(`
    SELECT * FROM time_entries
    WHERE employee_id = ? AND date(clock_in) >= ? AND date(clock_in) <= ? AND clock_out IS NOT NULL
    ORDER BY clock_in
  `).all(employeeId, periodStart, periodEnd);

  // Group by week (Mon-Sun), then calc OT
  const weeklyMins = {};
  entries.forEach(e => {
    const d = new Date(e.clock_in);
    // Get Monday of that week
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const weekKey = monday.toISOString().slice(0, 10);
    const mins = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000);
    weeklyMins[weekKey] = (weeklyMins[weekKey] || 0) + mins;
  });

  let totalRegular = 0, totalOvertime = 0;
  Object.values(weeklyMins).forEach(mins => {
    const reg = Math.min(mins, 2400); // 40hrs = 2400 mins
    const ot = Math.max(0, mins - 2400);
    totalRegular += reg;
    totalOvertime += ot;
  });
  return { totalRegular, totalOvertime };
}

// ---- API ROUTES ----

// PIN login
app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  const emp = db.prepare('SELECT * FROM employees WHERE pin = ?').get(pin);
  if (!emp) return res.status(401).json({ error: 'Invalid PIN' });
  res.json({ id: emp.id, name: emp.name, is_admin: emp.is_admin });
});

// Get all employees (admin)
app.get('/api/employees', (req, res) => {
  const emps = db.prepare('SELECT id, name, is_admin FROM employees ORDER BY name').all();
  res.json(emps);
});

// Add employee (admin)
app.post('/api/employees', (req, res) => {
  const { name, pin, is_admin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  const existing = db.prepare('SELECT id FROM employees WHERE pin = ?').get(pin);
  if (existing) return res.status(400).json({ error: 'PIN already in use' });
  const result = db.prepare('INSERT INTO employees (name, pin, is_admin) VALUES (?, ?, ?)').run(name, pin, is_admin ? 1 : 0);
  res.json({ id: result.lastInsertRowid, name, is_admin: is_admin ? 1 : 0 });
});

// Edit employee (admin)
app.put('/api/employees/:id', (req, res) => {
  const { name, is_admin } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE employees SET name = ?, is_admin = ? WHERE id = ?').run(name, is_admin ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Reset PIN (admin)
app.put('/api/employees/:id/pin', (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  const existing = db.prepare('SELECT id FROM employees WHERE pin = ? AND id != ?').get(pin, req.params.id);
  if (existing) return res.status(400).json({ error: 'PIN already in use' });
  db.prepare('UPDATE employees SET pin = ? WHERE id = ?').run(pin, req.params.id);
  res.json({ ok: true });
});

// Delete employee (admin)
app.delete('/api/employees/:id', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(req.params.id);
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Clock status for employee
app.get('/api/status/:employeeId', (req, res) => {
  const open = db.prepare(`
    SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1
  `).get(req.params.employeeId);
  res.json({ clocked_in: !!open, entry: open || null });
});

// Clock in
app.post('/api/clockin', (req, res) => {
  const { employee_id } = req.body;
  const open = db.prepare('SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(employee_id);
  if (open) return res.status(400).json({ error: 'Already clocked in' });
  const result = db.prepare('INSERT INTO time_entries (employee_id, clock_in) VALUES (?, datetime("now"))').run(employee_id);
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid);
  res.json(entry);
});

// Clock out
app.post('/api/clockout', (req, res) => {
  const { employee_id } = req.body;
  const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1').get(employee_id);
  if (!open) return res.status(400).json({ error: 'Not clocked in' });

  const now = new Date();
  const clockIn = new Date(open.clock_in);
  const totalMins = Math.round((now - clockIn) / 60000);

  // Simple daily overtime: >8hrs/day = OT (also tracked weekly in reports)
  const regular = Math.min(totalMins, 480);
  const overtime = Math.max(0, totalMins - 480);

  db.prepare(`
    UPDATE time_entries SET clock_out = datetime('now'), regular_mins = ?, overtime_mins = ? WHERE id = ?
  `).run(regular, overtime, open.id);

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id);
  res.json(entry);
});

// Today's log for employee
app.get('/api/today/:employeeId', (req, res) => {
  const entries = db.prepare(`
    SELECT * FROM time_entries
    WHERE employee_id = ? AND date(clock_in) = date('now')
    ORDER BY clock_in
  `).all(req.params.employeeId);
  res.json(entries);
});

// Pay periods list
app.get('/api/payperiods', (req, res) => {
  res.json(getPayPeriods(12));
});

// Admin: report for a pay period
app.get('/api/report', (req, res) => {
  const { start, end, employee_id } = req.query;
  let empQuery = 'SELECT id, name FROM employees WHERE is_admin = 0 ORDER BY name';
  let emps = db.prepare(empQuery).all();
  if (employee_id) emps = emps.filter(e => e.id == employee_id);

  const report = emps.map(emp => {
    const entries = db.prepare(`
      SELECT * FROM time_entries
      WHERE employee_id = ? AND date(clock_in) >= ? AND date(clock_in) <= ?
      ORDER BY clock_in
    `).all(emp.id, start, end);

    let totalMins = 0;
    const days = new Set();
    entries.forEach(e => {
      if (e.clock_out) {
        const mins = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000);
        totalMins += mins;
        days.add(e.clock_in.slice(0, 10));
      }
    });

    const { totalRegular, totalOvertime } = calcOvertimeForPeriod(emp.id, start, end);

    return {
      employee: emp,
      totalMins,
      totalRegular,
      totalOvertime,
      days: days.size,
      entries: entries.map(e => ({
        ...e,
        durationMins: e.clock_out ? Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000) : null
      }))
    };
  });

  res.json(report);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TimeClock running on http://localhost:${PORT}`));
// ---- ADMIN TIME ENTRY MANAGEMENT ----

// Get all entries for an employee (admin)
app.get('/api/entries/:employeeId', (req, res) => {
  const { start, end } = req.query;
  let sql = `SELECT * FROM time_entries WHERE employee_id = ?`;
  const params = [req.params.employeeId];
  if (start && end) { sql += ` AND date(clock_in) >= ? AND date(clock_in) <= ?`; params.push(start, end); }
  sql += ` ORDER BY clock_in DESC`;
  res.json(db.prepare(sql).all(...params));
});

// Add a manual time entry (admin)
app.post('/api/entries', (req, res) => {
  const { employee_id, clock_in, clock_out } = req.body;
  if (!employee_id || !clock_in) return res.status(400).json({ error: 'employee_id and clock_in are required' });
  if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  let regular_mins = 0, overtime_mins = 0;
  if (clock_out) {
    const totalMins = Math.round((new Date(clock_out) - new Date(clock_in)) / 60000);
    regular_mins = Math.min(totalMins, 480);
    overtime_mins = Math.max(0, totalMins - 480);
  }
  const result = db.prepare(`
    INSERT INTO time_entries (employee_id, clock_in, clock_out, regular_mins, overtime_mins)
    VALUES (?, ?, ?, ?, ?)
  `).run(employee_id, clock_in, clock_out || null, regular_mins, overtime_mins);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid));
});

// Edit a time entry (admin)
app.put('/api/entries/:id', (req, res) => {
  const { clock_in, clock_out } = req.body;
  if (!clock_in) return res.status(400).json({ error: 'clock_in is required' });
  if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  let regular_mins = 0, overtime_mins = 0;
  if (clock_out) {
    const totalMins = Math.round((new Date(clock_out) - new Date(clock_in)) / 60000);
    regular_mins = Math.min(totalMins, 480);
    overtime_mins = Math.max(0, totalMins - 480);
  }
  db.prepare(`
    UPDATE time_entries SET clock_in=?, clock_out=?, regular_mins=?, overtime_mins=? WHERE id=?
  `).run(clock_in, clock_out || null, regular_mins, overtime_mins, req.params.id);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id=?').get(req.params.id));
});

// Delete a time entry (admin)
app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});