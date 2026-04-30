#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── Time helpers ─────────────────────────────────────────────────────

const MAX_AGE_DAYS = 3;

function timeAgo(date) {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function isTooOld(date) {
  if (!date) return false; // no date info → keep
  return Date.now() - new Date(date).getTime() > MAX_AGE_DAYS * 86_400_000;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: j.updated_at || null,
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedAt: j.publishedAt || null,
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  if (!existsSync(PIPELINE_PATH)) {
    mkdirSync('data', { recursive: true });
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${o.score ? ` | score:${o.score}` : ''}${o.location ? ` | location:${o.location}` : ''}${o.postedAt ? ` | posted:${o.postedAt}` : ''}${o.source ? ` | source:${o.source}` : ''}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}${o.score ? ` | score:${o.score}` : ''}${o.location ? ` | location:${o.location}` : ''}${o.postedAt ? ` | posted:${o.postedAt}` : ''}${o.source ? ` | source:${o.source}` : ''}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Heuristic fit scorer ────────────────────────────────────────────

function scoreOffer(offer, profile) {
  let score = 3.0; // baseline
  const title = offer.title.toLowerCase();
  const company = offer.company.toLowerCase();
  const location = (offer.location || '').toLowerCase();

  // Company tier bonus
  const tier1 = (profile?.job_search?.priority_companies?.tier1 || []).map(c => c.toLowerCase());
  const tier2 = (profile?.job_search?.priority_companies?.tier2 || []).map(c => c.toLowerCase());
  if (tier1.some(c => company.includes(c) || c.includes(company))) score += 1.5;
  else if (tier2.some(c => company.includes(c) || c.includes(company))) score += 0.8;

  // New grad / entry level boost
  const newGradTerms = ['new grad', 'entry level', 'early career', 'university', 'junior', 'associate', 'swe i', 'engineer i', '0-2'];
  if (newGradTerms.some(t => title.includes(t))) score += 0.8;

  // Seniority penalty
  const seniorTerms = ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'head of'];
  if (seniorTerms.some(t => title.includes(t))) score -= 1.5;

  // Tech stack match bonus (Kapo's core stack)
  const stackTerms = ['backend', 'distributed', 'platform', 'infrastructure', 'data', 'full stack', 'fullstack', 'python', 'java', 'typescript'];
  if (stackTerms.some(t => title.includes(t))) score += 0.4;

  // Location bonus
  const preferredLocations = ['remote', 'seattle', 'provo', 'utah', 'san francisco', 'new york'];
  if (preferredLocations.some(l => location.includes(l))) score += 0.3;

  return Math.min(5.0, Math.max(1.0, Math.round(score * 10) / 10));
}

function scoreColor(score) {
  if (score >= 4.5) return 0x57F287; // green — strong match
  if (score >= 3.5) return 0xFEE75C; // yellow — good match
  if (score >= 3.0) return 0xEB459E; // pink — possible
  return 0x95A5A6;                   // grey — weak
}

function scoreLabel(score) {
  if (score >= 4.5) return '🟢 Strong match';
  if (score >= 3.5) return '🟡 Good match';
  if (score >= 3.0) return '🟠 Possible';
  return '⚪ Weak';
}

// ── Discord / Slack notifications ──────────────────────────────────

const DISCORD_MIN_SCORE = 3.0; // only notify for jobs scoring ≥ this

async function sendDiscordNotification(offers, webhookUrl) {
  if (!webhookUrl || offers.length === 0) return;

  // Only send offers that have a score (pre-scored) and meet the threshold
  const notable = offers.filter(o => (o.score || 0) >= DISCORD_MIN_SCORE)
    .sort((a, b) => b.score - a.score); // best first

  if (notable.length === 0) {
    console.log('Discord: no offers above score threshold, skipping notification');
    return;
  }

  const CHUNK = 10; // Discord max embeds per message
  for (let i = 0; i < notable.length; i += CHUNK) {
    const chunk = notable.slice(i, i + CHUNK);
    const embeds = chunk.map(o => {
      const ago = timeAgo(o.postedAt);
      return {
        title: `${o.company} — ${o.title}`,
        url: o.url,
        color: scoreColor(o.score),
        description: `\`\`\`\n${o.url}\n\`\`\``,
        fields: [
          { name: 'Fit Score', value: `${o.score}/5  ${scoreLabel(o.score)}`, inline: false },
          { name: 'Posted', value: ago || 'Unknown', inline: true },
          { name: 'Location', value: o.location || 'Not specified', inline: true },
          { name: 'Evaluate', value: `\`/career-ops apply ${o.url}\``, inline: false },
        ],
      };
    });

    const isFirst = i === 0;
    const body = {
      username: 'Career-Ops Scanner',
      avatar_url: 'https://em-content.zobj.net/source/twitter/376/briefcase_1f4bc.png',
      ...(isFirst && {
        content: `⚡ **${notable.length} matching SWE job${notable.length === 1 ? '' : 's'}** (${offers.length} total found) — sorted by fit score`,
      }),
      embeds,
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn(`Discord webhook returned ${res.status}`);
    } catch (err) {
      console.warn('Discord notification failed:', err.message);
    }

    if (i + CHUNK < notable.length) {
      await new Promise(r => setTimeout(r, 1500)); // respect rate limit
    }
  }

  console.log(`Discord: sent ${notable.length} scored offers (${offers.length - notable.length} below threshold)`);
}

async function sendSlackNotification(offers, webhookUrl) {
  if (!webhookUrl || offers.length === 0) return;
  const lines = offers.map(o => `• <${o.url}|${o.company} — ${o.title}> (${o.location || 'N/A'})`).join('\n');
  const body = {
    text: `⚡ *${offers.length} new SWE job${offers.length === 1 ? '' : 's'} found*\n${lines}\n\nRun \`/career-ops pipeline\` to evaluate.`,
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`Slack webhook returned ${res.status}`);
  } catch (err) {
    console.warn('Slack notification failed:', err.message);
  }
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── LinkedIn Guest API scanner ──────────────────────────────────────
// Uses the unauthenticated guest endpoint — no login, no Playwright, CI-compatible.
// LinkedIn ToS prohibits automation but no account is at risk here (no credentials).
// GitHub Actions shared IPs can get 429s; all errors are non-fatal.

function parseLinkedInHtml(html) {
  // Extract per-card fields by splitting on the entity-urn attribute
  const jobIds = [...html.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map(m => m[1]);
  const titles = [...html.matchAll(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const companies = [...html.matchAll(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const locations = [...html.matchAll(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const dates = [...html.matchAll(/<time[^>]*datetime="([^"]+)"/g)].map(m => m[1]);

  const jobs = [];
  for (let i = 0; i < jobIds.length; i++) {
    if (!jobIds[i] || !titles[i]) continue;
    jobs.push({
      title: titles[i],
      url: `https://www.linkedin.com/jobs/view/${jobIds[i]}`,
      company: companies[i] || 'Unknown',
      location: locations[i] || '',
      postedAt: dates[i] ? new Date(dates[i]).toISOString() : null,
    });
  }
  return jobs;
}

async function fetchLinkedInPage(keywords, location, start, liConfig) {
  const params = new URLSearchParams({
    keywords,
    location,
    start: String(start),
    count: '25',
    f_E: liConfig.experience_levels || '1,2,3',
    f_TPR: `r${(liConfig.posted_within_hours || 24) * 3600}`,
  });
  if (liConfig.work_type) params.set('f_WT', liConfig.work_type);

  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.status === 429) throw new Error('rate-limited (429)');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function scanLinkedIn(config, titleFilter, seenUrls, seenCompanyRoles) {
  const liConfig = config.linkedin_search;
  if (!liConfig || liConfig.enabled === false) return [];

  const queries = liConfig.queries || [];
  if (queries.length === 0) return [];

  const delay = liConfig.delay_between_requests_ms || 2500;
  const newOffers = [];

  console.log(`\nLinkedIn: scanning ${queries.length} queries (guest API)...`);

  for (const query of queries) {
    const { keywords, location = 'United States' } = query;
    let start = 0;

    while (start < 75) { // max 3 pages (75 results) per query
      try {
        const html = await fetchLinkedInPage(keywords, location, start, liConfig);
        const jobs = parseLinkedInHtml(html);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (!titleFilter(job.title)) continue;
          if (isTooOld(job.postedAt)) continue;
          if (seenUrls.has(job.url)) continue;
          const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
          if (seenCompanyRoles.has(key)) continue;
          seenUrls.add(job.url);
          seenCompanyRoles.add(key);
          newOffers.push({ ...job, source: 'linkedin-guest' });
        }

        start += 25;
        if (jobs.length < 25) break; // last page

        if (start < 75) await new Promise(r => setTimeout(r, delay));
      } catch (err) {
        console.warn(`  LinkedIn "${keywords}" (start=${start}): ${err.message} — skipping`);
        break;
      }
    }

    // Pause between queries to avoid triggering rate limits
    if (queries.indexOf(query) < queries.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`LinkedIn: ${newOffers.length} new offer${newOffers.length === 1 ? '' : 's'} found`);
  return newOffers;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString(); // full ISO datetime for precision
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (isTooOld(job.postedAt)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 4b. LinkedIn guest API scan (opt-in)
  if (!filterCompany) { // skip LinkedIn when scanning a single company
    const linkedInOffers = await scanLinkedIn(config, titleFilter, seenUrls, seenCompanyRoles);
    newOffers.push(...linkedInOffers);
  }

  // 5. Write results + notify
  if (!dryRun && newOffers.length > 0) {
    // Load profile for scoring
    let profile = null;
    const profilePath = 'config/profile.yml';
    if (existsSync(profilePath)) {
      try { profile = parseYaml(readFileSync(profilePath, 'utf-8')); } catch {}
    }

    // Score every offer against candidate profile
    const scoredOffers = newOffers.map(o => ({ ...o, score: scoreOffer(o, profile) }));

    appendToPipeline(scoredOffers);
    appendToScanHistory(scoredOffers, date);

    // Discord/Slack notification
    if (profile) {
      try {
        const discordWebhook = profile?.notify?.discord_webhook;
        const slackWebhook = profile?.notify?.slack_webhook;
        if (discordWebhook) await sendDiscordNotification(scoredOffers, discordWebhook);
        if (slackWebhook) await sendSlackNotification(scoredOffers, slackWebhook);
      } catch (err) {
        console.warn('Notification error:', err.message);
      }
    }
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
