#!/usr/bin/env node
'use strict';
/**
 * preload-apollo-leads.js: pre-build lead lists from Apollo.io
 *
 * Two-step process (Apollo's API requires this):
 *   1. SEARCH: /api/v1/mixed_people/api_search (free, no credits)
 *      Finds people matching the segment keywords but does NOT return emails.
 *   2. ENRICH: /v1/people/match (uses 1 credit per person)
 *      Reveals email for each person we want to contact.
 *
 * Usage:
 *   node src/preload-apollo-leads.js                     # Dry run: search only, show counts
 *   node src/preload-apollo-leads.js --save              # Search + enrich + save to cache
 *   node src/preload-apollo-leads.js --save --pages=3    # 3 pages per segment
 *   node src/preload-apollo-leads.js --search-only       # Search only, save without emails (free)
 *
 * Credits: only the enrich step costs credits (1 per person). The script prints
 * the maximum credit spend before it starts, and the dry run spends nothing.
 */

const fs = require('fs');
const path = require('path');
const { STATE_DIR, segments, isInternal } = require('./config');

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
if (!APOLLO_API_KEY) {
  console.error('❌ Missing APOLLO_API_KEY in .env');
  process.exit(1);
}

const SAVE = process.argv.includes('--save');
const SEARCH_ONLY = process.argv.includes('--search-only');
const PAGES_ARG = process.argv.find(a => a.startsWith('--pages'));
const PAGES = PAGES_ARG ? parseInt(PAGES_ARG.split('=')[1]) || 1 : 1;
const LEADS_CACHE = path.join(STATE_DIR, 'cold-outreach-leads-cache.json');

// q_keywords must be SHORT: Apollo AND-matches all terms.
const SEARCH_CONFIGS = segments.segments;

// Client-side title filter, applied AFTER search results come back
const TITLE_KEYWORDS = segments.titleKeywords;

function matchesTargetTitle(title) {
  if (!title) return true; // keep people with no title (can filter later)
  const lower = title.toLowerCase();
  return TITLE_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Step 1: Search (free, no credits) ────────────────────────────────────────
// api_search only supports q_keywords (simple terms).
// Filtering by title/location is done CLIENT-SIDE after results come back.
function buildSearchURL(keywords, page, perPage) {
  // Use simple string concatenation: URLSearchParams was encoding inconsistently
  return `https://api.apollo.io/api/v1/mixed_people/api_search`
    + `?q_keywords=${encodeURIComponent(keywords)}`
    + `&per_page=${perPage}`
    + `&page=${page}`;
}

async function searchApollo(config, page = 1) {
  const url = buildSearchURL(config.q_keywords, page, 50);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo search ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // api_search puts total_entries at top level, no pagination object
  const totalResults = data.total_entries || data.pagination?.total_entries || 0;
  const perPage = 50;
  return {
    people: data.people || [],
    totalResults,
    totalPages: Math.ceil(totalResults / perPage),
  };
}

// ── Step 2: Enrich to get email (1 credit per person) ────────────────────────
async function enrichPerson(person) {
  // Try enrichment using their Apollo ID, name, and org domain
  const body = {};
  if (person.id) body.id = person.id;
  if (person.first_name) body.first_name = person.first_name;
  if (person.last_name) body.last_name = person.last_name;
  if (person.organization?.primary_domain) {
    body.organization_domain = person.organization.primary_domain;
  }
  if (person.linkedin_url) body.linkedin_url = person.linkedin_url;
  body.reveal_personal_emails = false;
  body.reveal_phone_number = false;

  const res = await fetch('https://api.apollo.io/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return null;
  const data = await res.json();
  // Return the full enriched person object (has email, full name, location, etc.)
  return data.person || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`🔍 Apollo Lead Pre-loader`);
  console.log(`   Mode: ${SEARCH_ONLY ? 'SEARCH ONLY (free)' : SAVE ? 'SEARCH + ENRICH + SAVE' : 'DRY RUN'}`);
  console.log(`   Pages per config: ${PAGES}`);
  if (!SEARCH_ONLY && SAVE) {
    console.log(`   ⚠️  Enrichment will use ~${PAGES * 50 * SEARCH_CONFIGS.length} credits (max)`);
  }
  console.log('='.repeat(60));

  const allPeople = [];    // raw search results (no email)
  const allLeads = [];     // enriched leads (with email)
  const seenIds = new Set();

  // ── Step 1: Search all configs (FREE) ──────────────────────────────────────
  for (const config of SEARCH_CONFIGS) {
    console.log(`\n📋 ${config.label}`);

    for (let page = 1; page <= PAGES; page++) {
      try {
        const result = await searchApollo(config, page);
        let newCount = 0;

        for (const person of result.people) {
          if (!person.id || seenIds.has(person.id)) continue;
          if (!person.has_email) continue;
          // Client-side title filter
          if (!matchesTargetTitle(person.title)) continue;
          seenIds.add(person.id);
          person._searchLabel = config.label;
          allPeople.push(person);
          newCount++;
        }

        console.log(`   Page ${page}: ${result.people.length} results, ${newCount} unique people (${result.totalResults} total available)`);
        await sleep(500);
      } catch (err) {
        console.error(`   ❌ Page ${page} error: ${err.message}`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Search complete: ${allPeople.length} unique people found`);

  if (allPeople.length === 0) {
    console.log('   No results: check your search filters or API key.');
    return;
  }

  // Show sample of what was found (before enrichment)
  console.log('\n   Sample (pre-enrichment):');
  allPeople.slice(0, 5).forEach(p => {
    const name = `${p.first_name || '?'} ${p.last_name_obfuscated || p.last_name || '?'}`;
    console.log(`     ${name}: ${p.title || 'N/A'} @ ${p.organization?.name || 'N/A'} (has_email: ${p.has_email})`);
  });

  if (SEARCH_ONLY) {
    // Save people without emails: useful for reviewing before spending credits
    if (SAVE) {
      const leads = allPeople.map(p => ({
        apolloId: p.id,
        email: '',  // not yet enriched
        firstName: p.first_name || '',
        lastName: p.last_name_obfuscated || p.last_name || '',
        title: p.title || '',
        company: p.organization?.name || '',
        companyDomain: p.organization?.primary_domain || '',
        location: '',  // not returned by search endpoint
        industry: p.organization?.industry || '',
        linkedinUrl: '',  // not returned by search endpoint
        searchLabel: p._searchLabel,
        needsEnrichment: true,
      }));
      fs.writeFileSync(LEADS_CACHE, JSON.stringify(leads, null, 2));
      console.log(`\n💾 Saved ${leads.length} people to cache (no emails yet: run without --search-only to enrich)`);
    }
    return;
  }

  // ── Step 2: Enrich to get emails (USES CREDITS) ───────────────────────────
  if (!SAVE) {
    console.log(`\n⚠️  Dry run: would enrich ${allPeople.length} people (${allPeople.length} credits)`);
    console.log('   Add --save to actually enrich and save leads.');
    return;
  }

  console.log(`\n📧 Enriching ${allPeople.length} people to get emails...`);
  let enriched = 0;
  let noEmail = 0;
  let errors = 0;

  for (let i = 0; i < allPeople.length; i++) {
    const person = allPeople[i];

    try {
      const enrichResult = await enrichPerson(person);

      if (enrichResult && enrichResult.email && !isInternal(enrichResult.email)) {
        allLeads.push({
          apolloId: person.id,
          email: enrichResult.email.toLowerCase(),
          firstName: enrichResult.first_name || person.first_name || '',
          lastName: enrichResult.last_name || '',
          title: enrichResult.title || person.title || '',
          company: enrichResult.organization?.name || person.organization?.name || '',
          companyDomain: enrichResult.organization?.primary_domain || person.organization?.primary_domain || '',
          location: enrichResult.city ? `${enrichResult.city}, ${enrichResult.country}` : (enrichResult.country || ''),
          industry: enrichResult.organization?.industry || person.organization?.industry || '',
          linkedinUrl: enrichResult.linkedin_url || '',
          searchLabel: person._searchLabel,
        });
        enriched++;
      } else {
        noEmail++;
      }

      // Progress update every 25 people
      if ((i + 1) % 25 === 0) {
        console.log(`   Progress: ${i + 1}/${allPeople.length} (${enriched} emails found, ${noEmail} no email)`);
      }

      // Rate limit: 200ms between enrichment calls
      await sleep(200);
    } catch (err) {
      errors++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Enrichment Summary`);
  console.log(`   People searched: ${allPeople.length} (free)`);
  console.log(`   Emails found: ${enriched} (${enriched} credits used)`);
  console.log(`   No email: ${noEmail}`);
  console.log(`   Errors: ${errors}`);

  // Breakdown by country
  const byCountry = {};
  allLeads.forEach(l => {
    const country = l.location?.split(', ').pop() || 'Unknown';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });
  console.log('\n   By country:');
  Object.entries(byCountry).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    console.log(`     ${c}: ${n}`);
  });

  // Breakdown by config
  const byConfig = {};
  allLeads.forEach(l => {
    byConfig[l.searchLabel] = (byConfig[l.searchLabel] || 0) + 1;
  });
  console.log('\n   By search config:');
  Object.entries(byConfig).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    console.log(`     ${c}: ${n}`);
  });

  // Save
  if (SAVE && allLeads.length > 0) {
    let existing = [];
    try {
      if (fs.existsSync(LEADS_CACHE)) {
        existing = JSON.parse(fs.readFileSync(LEADS_CACHE, 'utf8'));
      }
    } catch {}

    const existingEmails = new Set(existing.map(l => l.email));
    const newOnly = allLeads.filter(l => !existingEmails.has(l.email));
    const merged = [...existing, ...newOnly];
    fs.writeFileSync(LEADS_CACHE, JSON.stringify(merged, null, 2));
    console.log(`\n✅ Saved ${newOnly.length} new leads (${merged.length} total in cache)`);
  }

  // Show sample leads
  console.log('\n📌 Sample leads:');
  allLeads.slice(0, 5).forEach(l => {
    console.log(`   ${l.firstName} ${l.lastName}: ${l.title} @ ${l.company} (${l.location}): ${l.email}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
