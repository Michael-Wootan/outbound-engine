#!/usr/bin/env node
'use strict';
/**
 * cold-email-outreach.js: daily B2B cold outbound via Apollo.io
 *
 * Runs from GitHub Actions on a weekday schedule.
 *
 * How it works:
 *   1. Searches Apollo.io for people matching today's segment (config/segments.json).
 *      Segments rotate, and pagination resumes where the last run stopped.
 *   2. Reveals an email only for people Apollo flags as having one (1 credit each),
 *      capped at twice the daily send limit.
 *   3. Filters out previously contacted, bounced and internal addresses.
 *   4. Claude Haiku writes a short personalized email and subject for each lead,
 *      from the company profile in config/company.json.
 *   5. Sends through the outreach domain's SMTP, 3 to 8 minutes apart.
 *   6. Emails the owner a daily summary of who was contacted.
 *
 * Usage:
 *   node src/cold-email-outreach.js              # Send up to 20 emails
 *   node src/cold-email-outreach.js --dry-run    # Preview without sending
 *   node src/cold-email-outreach.js --limit=10   # Override daily limit
 *
 * Env vars: see .env.example
 */

const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const { STATE_DIR, company, segments, isInternal } = require('./config');

// ── Config ────────────────────────────────────────────────────────────────────
const APOLLO_API_KEY     = process.env.APOLLO_API_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const OUTREACH_HOST      = process.env.OUTREACH_SMTP_HOST;
const OUTREACH_PORT      = parseInt(process.env.OUTREACH_SMTP_PORT || '587');
const OUTREACH_USER      = process.env.OUTREACH_SMTP_USER;
const OUTREACH_PASS      = process.env.OUTREACH_SMTP_PASS;
const OUTREACH_FROM      = process.env.OUTREACH_FROM_EMAIL;
const SENDER_NAME        = process.env.SENDER_NAME || company.senderName;
const EMAIL_NOTIFY       = process.env.EMAIL_NOTIFY;
const CLAUDE_MODEL       = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_PASS         = process.env.GMAIL_APP_PASSWORD;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit'));
const DAILY_LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1] || LIMIT_ARG.split(' ')[1]) || 20 : 20;

const OUTREACH_LOG    = path.join(STATE_DIR, 'cold-outreach-log.json');
const LEADS_CACHE     = path.join(STATE_DIR, 'cold-outreach-leads-cache.json');

// ── Apollo.io search segments ─────────────────────────────────────────────────
// One segment per run, rotated daily. Apollo AND-matches every term in
// q_keywords, so each segment is two or three short words.
const SEARCH_CONFIGS = segments.segments;

// ── Outreach log ──────────────────────────────────────────────────────────────
function loadLog() {
  try {
    if (fs.existsSync(OUTREACH_LOG)) return JSON.parse(fs.readFileSync(OUTREACH_LOG, 'utf8'));
  } catch {}
  return {
    contacted: [],        // { email, name, company, dateSent, apolloId }
    bounced: [],          // emails that bounced
    replied: [],          // emails that got replies (manual tracking)
    searchIndex: 0,       // which SEARCH_CONFIG to use next
    pageNum: 1,           // Apollo pagination within current search
    totalSent: 0,
    dailyLog: [],         // [{ date, sent, skipped, errors }]
  };
}
function saveLog(data) {
  fs.writeFileSync(OUTREACH_LOG, JSON.stringify(data, null, 2));
}

function loadLeadsCache() {
  try {
    if (fs.existsSync(LEADS_CACHE)) return JSON.parse(fs.readFileSync(LEADS_CACHE, 'utf8'));
  } catch {}
  return [];
}
function saveLeadsCache(leads) {
  fs.writeFileSync(LEADS_CACHE, JSON.stringify(leads, null, 2));
}

// ── Apollo.io API ─────────────────────────────────────────────────────────────
// api_search only supports q_keywords (short terms). The title filter lives in
// preload-apollo-leads.js, which builds the cache in bulk before a campaign.
function buildSearchURL(keywords, page, perPage) {
  return `https://api.apollo.io/api/v1/mixed_people/api_search`
    + `?q_keywords=${encodeURIComponent(keywords)}`
    + `&per_page=${perPage}`
    + `&page=${page}`;
}

async function searchApolloLeads(config, page = 1, perPage = 50) {
  const url = buildSearchURL(config.q_keywords, page, perPage);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // New api_search puts total_entries at top level, no pagination object
  const totalResults = data.total_entries || data.pagination?.total_entries || 0;
  return {
    people: data.people || [],
    totalResults,
    totalPages: Math.ceil(totalResults / perPage),
  };
}

/**
 * Enrich a lead to get their full data including email (1 credit per call)
 */
async function revealEmail(apolloId) {
  const res = await fetch('https://api.apollo.io/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify({
      id: apolloId,
      reveal_personal_emails: false,
      reveal_phone_number: false,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.person || null;  // Return full enriched person (has email, full name, location)
}

// ── Claude Haiku Email Writer ─────────────────────────────────────────────────
async function generatePersonalizedEmail(lead) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const bannedLine = (company.bannedWords || []).length
    ? `- Never use these words: ${company.bannedWords.join(', ')}\n`
    : '';

  const prompt = `Write a short, personalized cold outreach email from ${company.name} (${company.description}) to ${company.audience}.

LEAD INFO:
- Name: ${lead.firstName} ${lead.lastName}
- Title: ${lead.title || 'N/A'}
- Company: ${lead.company || 'N/A'}
- Location: ${lead.location || company.defaultRegion || 'N/A'}

WHAT ${company.name.toUpperCase()} OFFERS:
${company.offers.map(o => `- ${o}`).join('\n')}

RULES:
- Keep it under 120 words
- Sound like a real person, not a template: conversational and warm
- Reference their company or role naturally if possible
${bannedLine}- End with a soft CTA (${company.cta})
- Include "Reply STOP to opt out" at the very bottom in small text
- Do NOT include a subject line, just the email body
- Sign off as "${company.signature}"

Write ONLY the email body, nothing else.`;

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

async function generateSubjectLine(lead) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Write a short, natural email subject line (under 8 words) for a cold outreach email from ${company.description} to ${lead.firstName} ${lead.lastName}${lead.company ? ' at ' + lead.company : ''}. Make it sound personal, not salesy. No emojis. Just the subject line, nothing else.`
    }],
  });

  return response.content[0].text.trim().replace(/^["']|["']$/g, '');
}

// ── Email sending ─────────────────────────────────────────────────────────────
function getOutreachTransporter() {
  return nodemailer.createTransport({
    host: OUTREACH_HOST,
    port: OUTREACH_PORT,
    secure: false,
    auth: { user: OUTREACH_USER, pass: OUTREACH_PASS },
  });
}

function getNotifyTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
}

async function sendOutreachEmail(transporter, lead, subject, body) {
  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${OUTREACH_FROM}>`,
    to: lead.email,
    subject,
    text: body,
    // Add List-Unsubscribe header for CAN-SPAM compliance
    headers: {
      'List-Unsubscribe': `<mailto:${OUTREACH_FROM}?subject=STOP>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

// ── Summary email ─────────────────────────────────────────────────────────────
async function sendDailySummary(sentLeads, skipped, errors) {
  const transporter = getNotifyTransporter();

  const leadsHtml = sentLeads.map(l =>
    `<tr>
      <td style="padding:4px 10px;border-bottom:1px solid #333">${l.firstName} ${l.lastName}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #333">${l.title || ''}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #333">${l.company || ''}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #333">${l.email}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #333">${l.location || ''}</td>
    </tr>`
  ).join('');

  const errHtml = errors.length
    ? `<p style="color:#ff5252"><strong>Errors (${errors.length}):</strong><br>${errors.map(e => `&bull; ${e}`).join('<br>')}</p>`
    : '';

  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_NOTIFY,
    subject: `[${company.name} | Report] Cold Outreach: ${sentLeads.length} sent${DRY_RUN ? ' (DRY RUN)' : ''}, ${skipped} skipped`,
    html: `
      <div style="font-family:sans-serif;background:#1a1a2e;color:#e0e0e0;padding:24px;border-radius:8px;max-width:800px">
        <h2 style="color:#4fc3f7;margin-top:0">📨 Daily Cold Email Outreach Report</h2>
        ${DRY_RUN ? '<p style="color:#ffd54f"><strong>⚡ DRY RUN: no emails were actually sent</strong></p>' : ''}
        <p><strong>${sentLeads.length}</strong> emails sent &nbsp;|&nbsp; <strong>${skipped}</strong> skipped (already contacted/no email) &nbsp;|&nbsp; <strong>${errors.length}</strong> errors</p>

        ${sentLeads.length > 0 ? `
        <table style="border-collapse:collapse;width:100%;font-size:13px;color:#e0e0e0;margin-top:16px">
          <tr style="background:#2a2a4a">
            <th style="padding:6px 10px;text-align:left">Name</th>
            <th style="padding:6px 10px;text-align:left">Title</th>
            <th style="padding:6px 10px;text-align:left">Company</th>
            <th style="padding:6px 10px;text-align:left">Email</th>
            <th style="padding:6px 10px;text-align:left">Location</th>
          </tr>
          ${leadsHtml}
        </table>
        ` : '<p style="color:#888">No new leads found today.</p>'}

        ${errHtml}

        <hr style="border-color:#333;margin:20px 0">
        <p style="font-size:12px;color:#888">
          Sent via: ${OUTREACH_FROM}<br>
          Follow-ups and reply handling run as separate scheduled jobs.
        </p>
      </div>
    `
  });
}

// ── Human-like delay ──────────────────────────────────────────────────────────
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`📨 ${company.name} Cold Email Outreach${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(50));

  // Apollo API key is optional: leads can come from CSV imports instead
  const hasApolloAPI = !!APOLLO_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in .env');
  if (!OUTREACH_HOST && !DRY_RUN) throw new Error('Missing OUTREACH_SMTP_HOST in .env');

  const log = loadLog();
  const contactedEmails = new Set(log.contacted.map(c => c.email.toLowerCase()));
  const bouncedEmails = new Set(log.bounced.map(e => e.toLowerCase()));

  // Decide which search config to use today (rotate through them)
  const searchConfig = SEARCH_CONFIGS[log.searchIndex % SEARCH_CONFIGS.length];
  console.log(`\n🔍 Search: "${searchConfig.label}" (config ${log.searchIndex % SEARCH_CONFIGS.length + 1}/${SEARCH_CONFIGS.length}, page ${log.pageNum})`);

  // ── Find leads from Apollo ────────────────────────────────────────────────
  let leads = loadLeadsCache();

  if (leads.length < DAILY_LIMIT && hasApolloAPI) {
    console.log('  Fetching fresh leads from Apollo.io API...');
    try {
      // Step 1: Search (free, no credits)
      const result = await searchApolloLeads(searchConfig, log.pageNum, 100);
      console.log(`  Found ${result.people.length} people (${result.totalResults} total matches, page ${log.pageNum}/${result.totalPages})`);

      // Step 2: Enrich each person to get email (1 credit each)
      // Only enrich people who have an email (has_email flag from search)
      const enrichable = result.people.filter(p => p.has_email && p.id);
      let enrichCount = 0;
      for (const person of enrichable) {
        if (enrichCount >= DAILY_LIMIT * 2) break; // don't over-enrich

        // Skip if already in cache or contacted
        if (leads.some(l => l.apolloId === person.id)) continue;

        try {
          const enriched = await revealEmail(person.id);
          if (!enriched || !enriched.email) continue;
          const email = enriched.email.toLowerCase();
          if (contactedEmails.has(email)) continue;
          if (bouncedEmails.has(email)) continue;
          if (isInternal(email)) continue;

          leads.push({
            apolloId: person.id,
            email,
            firstName: enriched.first_name || person.first_name || '',
            lastName: enriched.last_name || '',
            title: enriched.title || person.title || '',
            company: enriched.organization?.name || person.organization?.name || '',
            location: enriched.city ? `${enriched.city}, ${enriched.country}` : (enriched.country || ''),
            linkedinUrl: enriched.linkedin_url || '',
          });
          enrichCount++;

          // Rate limit enrichment calls
          await new Promise(r => setTimeout(r, 200));
        } catch (enrichErr) {
          // Skip failed enrichments silently
        }
      }
      console.log(`  Enriched ${enrichCount} leads with emails (from ${enrichable.length} with has_email)`);

      // Advance pagination
      if (log.pageNum >= result.totalPages) {
        log.searchIndex = (log.searchIndex + 1) % SEARCH_CONFIGS.length;
        log.pageNum = 1;
      } else {
        log.pageNum++;
      }
      saveLog(log);
      saveLeadsCache(leads);

    } catch (e) {
      console.log(`  ❌ Apollo API error: ${e.message}`);
      if (leads.length === 0 && !hasApolloAPI) {
        console.log('\n  💡 No Apollo API key and no cached leads.');
        console.log('     Import leads from CSV: node src/import-apollo-csv.js <file.csv> --save');
        console.log('     Export from: app.apollo.io → People Search → Export → CSV\n');
        throw new Error('No leads available. Import leads from Apollo CSV export first.');
      }
      if (leads.length === 0) throw e;
    }
  } else if (leads.length < DAILY_LIMIT && !hasApolloAPI) {
    if (leads.length === 0) {
      console.log('\n  ⚠️  No Apollo API key configured and no cached leads.');
      console.log('  💡 Import leads from Apollo CSV export:');
      console.log('     1. Go to app.apollo.io → People Search');
      console.log('     2. Set filters and export as CSV');
      console.log('     3. Run: node src/import-apollo-csv.js <file.csv> --save');
      throw new Error('No leads available. Import leads from Apollo CSV export first.');
    } else {
      console.log(`  ℹ️  Using ${leads.length} cached/CSV-imported leads (no Apollo API configured)`);
    }
  }

  console.log(`\n📋 ${leads.length} leads available (sending up to ${DAILY_LIMIT})`);

  // ── Send emails ───────────────────────────────────────────────────────────
  const outreachTransporter = DRY_RUN ? null : getOutreachTransporter();
  const sentLeads = [];
  const errors = [];
  let skipped = 0;
  let leadIndex = 0;

  while (sentLeads.length < DAILY_LIMIT && leadIndex < leads.length) {
    const lead = leads[leadIndex];
    leadIndex++;

    // Double check not already contacted
    if (contactedEmails.has(lead.email)) { skipped++; continue; }
    if (bouncedEmails.has(lead.email)) { skipped++; continue; }

    try {
      // Generate personalized email
      console.log(`\n  ✍️  Writing email for ${lead.firstName} ${lead.lastName} (${lead.company || lead.title})...`);
      const [emailBody, subject] = await Promise.all([
        generatePersonalizedEmail(lead),
        generateSubjectLine(lead),
      ]);

      console.log(`  📧 Subject: "${subject}"`);
      console.log(`  📬 To: ${lead.email}`);

      if (!DRY_RUN) {
        await sendOutreachEmail(outreachTransporter, lead, subject, emailBody);
        console.log(`  ✅ Sent!`);
      } else {
        console.log(`  ⏭️  DRY RUN: would send`);
        console.log(`  Body preview: ${emailBody.slice(0, 100)}...`);
      }

      // Track as contacted
      log.contacted.push({
        email: lead.email,
        name: `${lead.firstName} ${lead.lastName}`,
        company: lead.company,
        title: lead.title,
        dateSent: new Date().toISOString(),
        apolloId: lead.apolloId,
      });
      contactedEmails.add(lead.email);
      sentLeads.push(lead);
      log.totalSent++;

      // Save after each send so progress isn't lost
      saveLog(log);

      // Stagger sends: 3-8 minutes apart to look natural
      if (sentLeads.length < DAILY_LIMIT && !DRY_RUN) {
        const delay = Math.floor(Math.random() * (8 - 3) + 3); // 3-8 minutes
        console.log(`  ⏱️  Waiting ${delay} minutes before next email...`);
        await randomDelay(delay * 60 * 1000, (delay + 1) * 60 * 1000);
      }

    } catch (e) {
      errors.push(`${lead.email}: ${e.message}`);
      console.log(`  ❌ Error: ${e.message}`);

      // If it's a bounce/invalid, track it
      if (/bounce|invalid|rejected|not found/i.test(e.message)) {
        log.bounced.push(lead.email);
      }
    }
  }

  // Remove sent/contacted leads from cache
  const remainingLeads = leads.filter(l => !contactedEmails.has(l.email) && !bouncedEmails.has(l.email));
  saveLeadsCache(remainingLeads);

  // Update daily log
  log.dailyLog.push({
    date: new Date().toISOString().split('T')[0],
    sent: sentLeads.length,
    skipped,
    errors: errors.length,
    searchConfig: searchConfig.label,
  });
  log.lastRun = new Date().toISOString();
  saveLog(log);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Done: ${sentLeads.length} sent, ${skipped} skipped, ${errors.length} errors`);
  console.log(`📊 All-time total: ${log.totalSent} emails sent`);
  if (errors.length) console.log(`⚠️  Errors:`, errors);

  // ── Send daily summary ────────────────────────────────────────────────────
  try {
    await sendDailySummary(sentLeads, skipped, errors);
    console.log(`📬 Summary email sent → ${EMAIL_NOTIFY}`);
  } catch (e) {
    console.warn(`⚠️  Could not send summary: ${e.message}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
