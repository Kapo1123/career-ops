#!/usr/bin/env node
import express from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3030;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────

function readFile(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

function parseTsv(text, skipHeader = true) {
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  return (skipHeader ? lines.slice(1) : lines).map(l => l.split('\t'));
}

function parseMdTable(text) {
  if (!text) return [];
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.every(c => /^[-: ]+$/.test(c))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

const VALID_STATUSES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

// ── /api/stats ───────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const history = parseTsv(readFile('data/scan-history.tsv'));
  const appRows = parseMdTable(readFile('data/applications.md'));
  const reports = existsSync(join(ROOT, 'reports'))
    ? readdirSync(join(ROOT, 'reports')).filter(f => f.endsWith('.md') && f !== '.gitkeep')
    : [];

  const statuses = {};
  for (const row of appRows.slice(1)) { // skip header
    const status = row[4] || 'Unknown';
    statuses[status] = (statuses[status] || 0) + 1;
  }

  res.json({
    total_scanned: history.length,
    total_applications: appRows.length > 1 ? appRows.length - 1 : 0,
    total_reports: reports.length,
    last_scan: history.length > 0 ? history[history.length - 1][1] : null,
    by_status: statuses,
  });
});

// ── /api/jobs (scan history) ─────────────────────────────────────────

app.get('/api/jobs', (req, res) => {
  const { q = '', company = '', source = '', days, page = 1 } = req.query;
  const PAGE_SIZE = 50;

  const rows = parseTsv(readFile('data/scan-history.tsv'));
  let jobs = rows.map(r => ({
    url: r[0], date: r[1], source: r[2], title: r[3], company: r[4], status: r[5],
  }));

  if (q) {
    const lq = q.toLowerCase();
    jobs = jobs.filter(j => j.title?.toLowerCase().includes(lq) || j.company?.toLowerCase().includes(lq));
  }
  if (company) jobs = jobs.filter(j => j.company?.toLowerCase().includes(company.toLowerCase()));
  if (source) jobs = jobs.filter(j => j.source === source);
  if (days) {
    const cutoff = Date.now() - Number(days) * 86400000;
    jobs = jobs.filter(j => new Date(j.date).getTime() >= cutoff);
  }

  jobs.sort((a, b) => new Date(b.date) - new Date(a.date));

  const total = jobs.length;
  const start = (Number(page) - 1) * PAGE_SIZE;
  res.json({ total, page: Number(page), pages: Math.ceil(total / PAGE_SIZE), jobs: jobs.slice(start, start + PAGE_SIZE) });
});

// ── /api/jobs/sources ────────────────────────────────────────────────

app.get('/api/jobs/sources', (req, res) => {
  const rows = parseTsv(readFile('data/scan-history.tsv'));
  const sources = [...new Set(rows.map(r => r[2]).filter(Boolean))].sort();
  res.json(sources);
});

// ── /api/pipeline ────────────────────────────────────────────────────

app.get('/api/pipeline', (req, res) => {
  const text = readFile('data/pipeline.md') || '';

  const historyDates = {};
  const histRows = parseTsv(readFile('data/scan-history.tsv'));
  for (const r of histRows) {
    if (r[0] && r[1]) historyDates[r[0]] = r[1];
  }

  const jobs = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[([ x])\] (https?:\/\/\S+)(.*)/);
    if (!m) continue;
    const done = m[1] === 'x';
    const url = m[2];
    const rest = m[3] || '';
    const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
    const posted = parts.find(p => p.startsWith('posted:'))?.replace('posted:', '')
      || historyDates[url]
      || null;
    jobs.push({
      done, url,
      company: parts[0] || '',
      title: parts[1] || '',
      score: parts.find(p => p.startsWith('score:'))?.replace('score:', '') || null,
      posted,
    });
  }
  res.json(jobs);
});

// ── PATCH /api/pipeline/check — mark a pipeline URL done/undone ──────

app.patch('/api/pipeline/check', (req, res) => {
  const { url, done } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const filePath = join(ROOT, 'data', 'pipeline.md');
  if (!existsSync(filePath)) return res.status(404).json({ error: 'pipeline.md not found' });

  let text = readFileSync(filePath, 'utf-8');
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(- \\[)[ x](\\] ${escaped})`, 'm');
  if (!re.test(text)) return res.status(404).json({ error: 'url not found in pipeline' });

  text = text.replace(re, `$1${done ? 'x' : ' '}$2`);
  writeFileSync(filePath, text);
  res.json({ ok: true });
});

// ── /api/applications ────────────────────────────────────────────────

app.get('/api/applications', (req, res) => {
  const rows = parseMdTable(readFile('data/applications.md'));
  if (rows.length < 2) return res.json([]);
  const apps = rows.slice(1).map(r => ({
    num: r[0], date: r[1], company: r[2], role: r[3],
    score: r[4], status: r[5], pdf: r[6], report: r[7], notes: r[8] || '',
  }));
  res.json(apps);
});

// ── PATCH /api/applications/status — update status in applications.md ─

app.patch('/api/applications/status', (req, res) => {
  const { num, company, status } = req.body;
  if (!status || !VALID_STATUSES.includes(status))
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  if (!num && !company)
    return res.status(400).json({ error: 'num or company required' });

  const filePath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(filePath)) return res.status(404).json({ error: 'applications.md not found' });

  let text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  let updated = false;

  // Table columns: | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
  // Indices after split('|'):  1   2       3        4      5       6     7       8       9
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 8) continue;
    const rowNum = cells[1].trim();
    if (rowNum === '#' || /^[-:]+$/.test(rowNum)) continue; // header / separator

    const matchByNum = num && rowNum === String(num);
    const matchByCompany = company && cells[3].trim().toLowerCase() === company.toLowerCase();

    if (matchByNum || matchByCompany) {
      cells[6] = ` ${status} `;
      lines[i] = cells.join('|');
      updated = true;
      if (matchByNum) break; // exact match — done
    }
  }

  if (!updated) return res.status(404).json({ error: 'application not found' });
  writeFileSync(filePath, lines.join('\n'));
  res.json({ ok: true });
});

// ── /api/reports ─────────────────────────────────────────────────────

app.get('/api/reports', (req, res) => {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) return res.json([]);
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep')
    .sort()
    .reverse();
  res.json(files.map(f => {
    const m = f.match(/^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
    return { file: f, num: m?.[1], slug: m?.[2], date: m?.[3] };
  }));
});

app.get('/api/reports/:file', (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
  const text = readFile(`reports/${file}`);
  if (!text) return res.status(404).json({ error: 'not found' });
  res.json({ content: text });
});

// ── /api/stories ─────────────────────────────────────────────────────

app.get('/api/stories', (req, res) => {
  const text = readFile('interview-prep/story-bank.md') || '';
  const stories = [];
  let current = null;

  for (const line of text.split('\n')) {
    const hm = line.match(/^###\s+\[([^\]]+)\]\s+(.+)$/);
    if (hm) {
      if (current) stories.push(current);
      current = { theme: hm[1], title: hm[2], fields: {}, raw: line };
      continue;
    }
    if (!current) continue;
    current.raw += '\n' + line;
    const fm = line.match(/^\*\*([^*]+)\*\*[:\s]+(.+)$/);
    if (fm) {
      const key = fm[1].replace(/[()]/g, '').trim();
      current.fields[key] = fm[2].trim();
    }
  }
  if (current) stories.push(current);
  res.json(stories);
});

app.put('/api/stories/:index', (req, res) => {
  const { original, updated } = req.body;
  const path = join(ROOT, 'interview-prep', 'story-bank.md');
  if (!existsSync(path)) return res.status(404).json({ error: 'not found' });
  let text = readFileSync(path, 'utf-8');
  if (!text.includes(original)) return res.status(409).json({ error: 'original not found — may have changed' });
  text = text.replace(original, updated);
  writeFileSync(path, text);
  res.json({ ok: true });
});

// ── /api/profile ─────────────────────────────────────────────────────

app.get('/api/profile', (req, res) => {
  const text = readFile('config/profile.yml');
  if (!text) return res.status(404).json({ error: 'not found' });
  try { res.json(yaml.load(text)); }
  catch { res.status(500).json({ error: 'parse error' }); }
});

// ── /api/scan (trigger scan) ─────────────────────────────────────────

app.post('/api/scan', (req, res) => {
  const dryRun = req.body?.dry_run === true;
  const args = ['scan.mjs'];
  if (dryRun) args.push('--dry-run');
  const result = spawnSync('node', args, { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
  res.json({ stdout: result.stdout, stderr: result.stderr, code: result.status });
});

// ── /api/ai-edit ─────────────────────────────────────────────────────

app.post('/api/ai-edit', async (req, res) => {
  const { story, instruction } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are a behavioral interview coach helping Kapo Kwok (BYU CS Dec 2025, OPT/H1B, new grad SWE) refine STAR+R stories. Return ONLY the revised story block in the same markdown format. No preamble or explanation.`,
    messages: [{ role: 'user', content: `Story:\n\n${story}\n\nInstruction: ${instruction}` }],
  });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body,
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ result: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all → SPA ──────────────────────────────────────────────────

app.get('/{*path}', (_, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Career-Ops UI → http://localhost:${PORT}`));
