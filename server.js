const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'timeclock.db'));

const WORK_TYPES = ['Class', 'Front Desk', 'Private Class'];
const ADMIN_EMAIL = 'ramoselitefitness@gmail.com';

// Email transporter — credentials set via Railway env vars
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendEmail(to, subject, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email not configured — skipping:', subject);
    return;
  }
  try {
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, html });
    console.log('Email sent:', subject);
  } catch(e) {
    console.error('Email error:', e.message);
  }
}

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

  CREATE TABLE IF NOT EXISTS timecard_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    notes TEXT,
    submitted_at TEXT NOT NULL,
    total_mins INTEGER DEFAULT 0,
    UNIQUE(employee_id, period_start),
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
`);

// Migrations
try { db.exec(`ALTER TABLE time_entries ADD COLUMN work_type TEXT NOT NULL DEFAULT 'Class'`); } catch(e) {}

// Seed
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get();
if (empCount.c === 0) {
  const ins = db.prepare('INSERT INTO employees (name, pin, is_admin) VALUES (?, ?, ?)');
  ins.run('Admin', '0000', 1);
  ins.run('Alex Martinez', '1111', 0);
  ins.run('Sam Chen', '2222', 0);
  ins.run('Jordan Lee', '3333', 0);
  ins.run('Taylor Brooks', '4444', 0);

  const p = db.prepare('INSERT INTO pay_periods (start_date, end_date) VALUES (?, ?)');
  p.run('2026-05-29', '2026-06-11');
  p.run('2026-05-15', '2026-05-28');
  p.run('2026-05-01', '2026-05-14');
  p.run('2026-04-17', '2026-04-30');
}

// Pay periods — biweekly Fri-Thu from anchor 2026-05-29
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

// Get current pay period based on today
function getCurrentPeriod() {
  const periods = getPayPeriods(12);
  const today = new Date().toISOString().slice(0, 10);
  return periods.find(p => today >= p.start && today <= p.end) || periods[0];
}

// Check if today is the Wednesday before the last day (Thursday) of a pay period
// Pay period ends Thursday, so Wed = end date minus 1 day
function isReminderDay() {
  const period = getCurrentPeriod();
  const endDate = new Date(period.end + 'T12:00:00');
  const warnDate = new Date(endDate);
  warnDate.setDate(endDate.getDate() - 1); // Wednesday
  const today = new Date().toISOString().slice(0, 10);
  const warnStr = warnDate.toISOString().slice(0, 10);
  return { isReminder: today === warnStr, period, warnDate: warnStr };
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

// ── AUTH ──
app.post('/api/login', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE pin = ?').get(req.body.pin);
  if (!emp) return res.status(401).json({ error: 'Invalid PIN' });
  // Return reminder info with login
  const { isReminder, period } = isReminderDay();
  res.json({ id: emp.id, name: emp.name, is_admin: emp.is_admin, reminderDay: isReminder, currentPeriod: period });
});

// ── EMPLOYEES ──
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
  res.json({ ok: true, is_admin: isAdminInt });
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
  db.prepare('DELETE FROM timecard_submissions WHERE employee_id = ?').run(req.params.id);
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── CLOCK ──
app.get('/api/status/:employeeId', (req, res) => {
  const open = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(req.params.employeeId);
  res.json({ clocked_in: !!open, entry: open || null });
});

app.post('/api/clockin', (req, res) => {
  const { employee_id, work_type } = req.body;
  if (!WORK_TYPES.includes(work_type)) return res.status(400).json({ error: 'Invalid work type' });
  const open = db.prepare('SELECT id FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(employee_id);
  if (open) return res.status(400).json({ error: 'Already clocked in' });
  // Check if current period is submitted
  const period = getCurrentPeriod();
  const sub = db.prepare('SELECT id FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').get(employee_id, period.start);
  if (sub) return res.status(400).json({ error: 'This pay period has been submitted and is locked.' });
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO time_entries (employee_id, work_type, clock_in) VALUES (?, ?, ?)').run(employee_id, work_type, now);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid));
});

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

app.get('/api/today/:employeeId', (req, res) => {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  res.json(db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_in >= ? ORDER BY clock_in`).all(req.params.employeeId, since));
});

app.get('/api/payperiods', (req, res) => res.json(getPayPeriods(12)));

// ── TIMECARD SUBMISSION ──
app.get('/api/submission/:employeeId', (req, res) => {
  const { period_start } = req.query;
  const sub = db.prepare('SELECT * FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').get(req.params.employeeId, period_start);
  res.json({ submitted: !!sub, submission: sub || null });
});

app.post('/api/submit', async (req, res) => {
  const { employee_id, period_start, period_end, notes } = req.body;
  if (!employee_id || !period_start) return res.status(400).json({ error: 'Missing required fields' });

  const existing = db.prepare('SELECT id FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').get(employee_id, period_start);
  if (existing) return res.status(400).json({ error: 'Already submitted for this period' });

  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.status(400).json({ error: 'Employee not found' });

  // Calculate total hours for email
  const entries = db.prepare(`
    SELECT * FROM time_entries WHERE employee_id = ? AND clock_in >= ? AND clock_in < date(?, '+1 day') AND clock_out IS NOT NULL
  `).all(employee_id, period_start, period_end);

  let totalMins = 0;
  const byType = {};
  WORK_TYPES.forEach(t => byType[t] = 0);
  entries.forEach(e => {
    const mins = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000);
    totalMins += mins;
    byType[e.work_type || 'Class'] = (byType[e.work_type || 'Class'] || 0) + mins;
  });

  const now = new Date().toISOString();
  db.prepare('INSERT INTO timecard_submissions (employee_id, period_start, period_end, notes, submitted_at, total_mins) VALUES (?, ?, ?, ?, ?, ?)').run(employee_id, period_start, period_end, notes || '', now, totalMins);

  // Format hours for email
  const fmtHrs = mins => `${(mins/60).toFixed(1)} hrs`;
  const typeRows = WORK_TYPES.map(t => `<tr><td style="padding:6px 12px;color:#71717a">${t}</td><td style="padding:6px 12px;font-weight:600">${fmtHrs(byType[t]||0)}</td></tr>`).join('');

  // Send email to admin
  await sendEmail(ADMIN_EMAIL, `⏱ Time Card Submitted — ${emp.name}`,
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f0f11;color:#f1f1f3;padding:32px;border-radius:12px">
      <h2 style="margin:0 0 8px;color:#ef4444">Time Card Submitted</h2>
      <p style="color:#71717a;margin:0 0 24px">Pay period: <strong style="color:#f1f1f3">${period_start} – ${period_end}</strong></p>
      <table style="width:100%;border-collapse:collapse;background:#18181b;border-radius:8px;overflow:hidden">
        <tr style="background:#222227"><td style="padding:10px 12px;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Employee</td><td style="padding:10px 12px;font-weight:700;font-size:16px">${emp.name}</td></tr>
        <tr><td style="padding:6px 12px;color:#71717a">Total hours</td><td style="padding:6px 12px;font-weight:700;color:#ef4444;font-size:18px">${fmtHrs(totalMins)}</td></tr>
        ${typeRows}
        ${notes ? `<tr style="background:#222227"><td style="padding:10px 12px;color:#71717a">Notes</td><td style="padding:10px 12px">${notes}</td></tr>` : ''}
        <tr style="background:#222227"><td style="padding:10px 12px;color:#71717a">Submitted at</td><td style="padding:10px 12px">${new Date(now).toLocaleString()}</td></tr>
      </table>
    </div>`
  );

  res.json({ ok: true, submitted_at: now });
});

// ── REPORT ──
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
        days.add(new Date(e.clock_in).toLocaleDateString('en-CA'));
        const t = e.work_type || 'Class';
        byType[t] = (byType[t] || 0) + mins;
      }
    });

    const { totalRegular, totalOvertime } = calcOvertimeForPeriod(emp.id, start, end);
    const submission = db.prepare('SELECT * FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').get(emp.id, start);

    return {
      employee: emp, totalMins, totalRegular, totalOvertime, byType, days: days.size,
      submission: submission || null,
      entries: entries.map(e => ({
        ...e,
        durationMins: e.clock_out ? Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 60000) : null
      }))
    };
  });

  res.json(report);
});

// ── ADMIN: UNLOCK / EDIT SUBMISSION ──

// Delete submission (unlock the period)
app.delete('/api/submission/:employeeId', (req, res) => {
  const { period_start } = req.query;
  if (!period_start) return res.status(400).json({ error: 'period_start required' });
  const result = db.prepare('DELETE FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').run(req.params.employeeId, period_start);
  console.log(`Unlock: emp=${req.params.employeeId} period=${period_start} rows=${result.changes}`);
  res.json({ ok: true, deleted: result.changes });
});

// Edit submission notes
app.put('/api/submission/:employeeId', (req, res) => {
  const { period_start, notes } = req.body;
  db.prepare('UPDATE timecard_submissions SET notes = ? WHERE employee_id = ? AND period_start = ?').run(notes || '', req.params.employeeId, period_start);
  const sub = db.prepare('SELECT * FROM timecard_submissions WHERE employee_id = ? AND period_start = ?').get(req.params.employeeId, period_start);
  res.json({ ok: true, submission: sub });
});

// ── ENTRIES (admin) ──
app.get('/api/entries/:employeeId', (req, res) => {
  const { start, end } = req.query;
  let sql = `SELECT * FROM time_entries WHERE employee_id = ?`;
  const params = [req.params.employeeId];
  if (start && end) { sql += ` AND clock_in >= ? AND clock_in < date(?, '+1 day')`; params.push(start, end); }
  sql += ` ORDER BY clock_in DESC`;
  res.json(db.prepare(sql).all(...params));
});

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

app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TimeClock running on http://localhost:${PORT}`));