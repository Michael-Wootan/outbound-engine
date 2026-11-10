#!/usr/bin/env node
'use strict';
/**
 * import-apollo-csv.js: import Apollo.io CSV exports into the leads cache
 *
 * A fallback for accounts without API access: export leads from Apollo's web
 * UI as CSV and import them into the same cache format used by
 * cold-email-outreach.js.
 *
 * Usage:
 *   node src/import-apollo-csv.js leads.csv                # Preview what will be imported
 *   node src/import-apollo-csv.js leads.csv --save         # Import and save to cache
 *   node src/import-apollo-csv.js *.csv --save             # Import multiple CSVs at once
 *   node src/import-apollo-csv.js leads/ --save            # Import all CSVs from a folder
 *
 * Apollo CSV columns (auto-detected):
 *   First Name, Last Name, Title, Company, Email, City, State, Country,
 *   LinkedIn Url, Company Linkedin Url, etc.
 *
 * The script:
 *   1. Reads CSV files (supports multiple files and folders)
 *   2. Maps Apollo columns to the lead cache format
 *   3. Deduplicates by email
 *   4. Filters out already-contacted leads (from cold-outreach-log.json)
 *   5. Merges with existing cache (doesn't overwrite)
 *   6. Saves to cold-outreach-leads-cache.json when --save is used
 */

const fs   = require('fs');
const path = require('path');
const { STATE_DIR, isInternal } = require('./config');

const ROOT        = process.cwd();
const LEADS_CACHE = path.join(STATE_DIR, 'cold-outreach-leads-cache.json');
const OUTREACH_LOG = path.join(STATE_DIR, 'cold-outreach-log.json');

// ── Simple CSV parser (no dependencies) ──────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header row: handle quoted fields
  const parseRow = (line) => {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map(h => h.replace(/^\uFEFF/, '')); // strip BOM
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    if (values.length < 2) continue; // skip empty/malformed rows

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

// ── Column mapping: Apollo CSV → lead cache format ───────────────────────────
// Apollo exports use these column names (case-insensitive matching)
const COLUMN_MAP = {
  // email
  email: ['email', 'email address', 'work email', 'corporate email', 'contact email'],
  // name
  firstName: ['first name', 'first_name', 'firstname'],
  lastName: ['last name', 'last_name', 'lastname'],
  // job
  title: ['title', 'job title', 'position', 'role'],
  company: ['company', 'company name', 'organization', 'organization name'],
  // location
  city: ['city', 'person city'],
  state: ['state', 'person state'],
  country: ['country', 'person country'],
  // links
  linkedinUrl: ['linkedin url', 'linkedin', 'person linkedin url', 'linkedin profile'],
  // ID (Apollo export includes this)
  apolloId: ['id', 'person id', 'apollo id', 'contact id'],
};

function findColumn(row, candidates) {
  const rowKeys = Object.keys(row).map(k => k.toLowerCase());
  for (const candidate of candidates) {
    const idx = rowKeys.findIndex(k => k === candidate.toLowerCase());
    if (idx !== -1) return Object.keys(row)[idx];
  }
  return null;
}

function mapRowToLead(row, columnKeys) {
  const get = (field) => {
    const key = columnKeys[field];
    return key ? (row[key] || '').trim() : '';
  };

  const email = get('email').toLowerCase();
  if (!email || !email.includes('@')) return null;

  const city = get('city');
  const state = get('state');
  const country = get('country');
  const locationParts = [city, state, country].filter(Boolean);

  return {
    apolloId: get('apolloId') || `csv-${email}`,
    email,
    firstName: get('firstName'),
    lastName: get('lastName'),
    title: get('title'),
    company: get('company'),
    location: locationParts.join(', '),
    linkedinUrl: get('linkedinUrl'),
    source: 'csv-import',
    importDate: new Date().toISOString().split('T')[0],
  };
}

// ── Load existing data ───────────────────────────────────────────────────────
function loadLeadsCache() {
  try {
    if (fs.existsSync(LEADS_CACHE)) return JSON.parse(fs.readFileSync(LEADS_CACHE, 'utf8'));
  } catch {}
  return [];
}

function loadContactedEmails() {
  try {
    if (fs.existsSync(OUTREACH_LOG)) {
      const log = JSON.parse(fs.readFileSync(OUTREACH_LOG, 'utf8'));
      return new Set([
        ...(log.contacted || []).map(c => c.email.toLowerCase()),
        ...(log.bounced || []).map(e => e.toLowerCase()),
      ]);
    }
  } catch {}
  return new Set();
}

// ── Resolve input paths (files, folders, globs) ─────────────────────────────
function resolveCSVFiles(args) {
  const files = [];
  for (const arg of args) {
    if (arg.startsWith('--')) continue;
    const resolved = path.resolve(ROOT, arg);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        // Import all CSVs from the folder
        const csvs = fs.readdirSync(resolved)
          .filter(f => f.toLowerCase().endsWith('.csv'))
          .map(f => path.join(resolved, f));
        files.push(...csvs);
      } else {
        files.push(resolved);
      }
    } else {
      console.log(`  ⚠️  File not found: ${arg}`);
    }
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const doSave = args.includes('--save');
  const csvFiles = resolveCSVFiles(args);

  if (csvFiles.length === 0) {
    console.log(`
📥 Apollo CSV Lead Importer
${'='.repeat(50)}

Usage:
  node src/import-apollo-csv.js <file.csv> [--save]
  node src/import-apollo-csv.js <folder/> [--save]
  node src/import-apollo-csv.js file1.csv file2.csv --save

How to export from Apollo:
  1. Go to app.apollo.io → People Search
  2. Set your filters (job titles, keywords, locations)
  3. Select leads → click "Export" → choose CSV
  4. Download the CSV and place it in this project folder
  5. Run this script with --save to import

Without --save, it just previews what would be imported.
`);
    return;
  }

  console.log(`📥 Apollo CSV Lead Importer`);
  console.log('='.repeat(50));

  // Load existing data
  const existingLeads = loadLeadsCache();
  const existingEmails = new Set(existingLeads.map(l => l.email.toLowerCase()));
  const contactedEmails = loadContactedEmails();

  console.log(`\n📊 Existing cache: ${existingLeads.length} leads`);
  console.log(`📊 Already contacted/bounced: ${contactedEmails.size} emails\n`);

  // Process each CSV file
  const allNewLeads = [];
  const allEmails = new Set([...existingEmails, ...contactedEmails]);

  for (const file of csvFiles) {
    console.log(`📄 Processing: ${path.basename(file)}`);
    const text = fs.readFileSync(file, 'utf8');
    const rows = parseCSV(text);

    if (rows.length === 0) {
      console.log(`  ⚠️  No data rows found\n`);
      continue;
    }

    // Auto-detect column mappings from first row
    const firstRow = rows[0];
    const columnKeys = {};
    for (const [field, candidates] of Object.entries(COLUMN_MAP)) {
      columnKeys[field] = findColumn(firstRow, candidates);
    }

    // Show detected columns
    console.log(`  Rows: ${rows.length}`);
    console.log(`  Columns detected:`);
    for (const [field, key] of Object.entries(columnKeys)) {
      if (key) console.log(`    ${field} → "${key}"`);
    }

    if (!columnKeys.email) {
      console.log(`  ❌ No email column found: skipping this file\n`);
      continue;
    }

    // Map and filter rows
    let imported = 0;
    let skippedDuplicate = 0;
    let skippedContacted = 0;
    let skippedNoEmail = 0;
    let skippedInternal = 0;

    for (const row of rows) {
      const lead = mapRowToLead(row, columnKeys);

      if (!lead) {
        skippedNoEmail++;
        continue;
      }
      if (isInternal(lead.email)) {
        skippedInternal++;
        continue;
      }
      if (contactedEmails.has(lead.email)) {
        skippedContacted++;
        continue;
      }
      if (allEmails.has(lead.email)) {
        skippedDuplicate++;
        continue;
      }

      allEmails.add(lead.email);
      allNewLeads.push(lead);
      imported++;
    }

    console.log(`  ✅ ${imported} new leads`);
    if (skippedDuplicate) console.log(`  ⏭️  ${skippedDuplicate} duplicates`);
    if (skippedContacted) console.log(`  ⏭️  ${skippedContacted} already contacted`);
    if (skippedNoEmail) console.log(`  ⏭️  ${skippedNoEmail} no email`);
    if (skippedInternal) console.log(`  ⏭️  ${skippedInternal} internal`);
    console.log();
  }

  // Summary
  console.log('='.repeat(50));
  console.log(`📊 Summary:`);
  console.log(`  New leads to import: ${allNewLeads.length}`);
  console.log(`  Total cache after import: ${existingLeads.length + allNewLeads.length}`);

  if (allNewLeads.length > 0) {
    // Show breakdown by country
    const byCountry = {};
    for (const lead of allNewLeads) {
      const country = lead.location.split(',').pop()?.trim() || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
    }
    console.log(`\n  By country:`);
    Object.entries(byCountry)
      .sort((a, b) => b[1] - a[1])
      .forEach(([country, count]) => {
        console.log(`    ${country}: ${count}`);
      });

    // Show sample leads
    console.log(`\n  Sample leads:`);
    allNewLeads.slice(0, 5).forEach(l => {
      console.log(`    ${l.firstName} ${l.lastName}, ${l.title} at ${l.company} (${l.email})`);
    });
    if (allNewLeads.length > 5) {
      console.log(`    ... and ${allNewLeads.length - 5} more`);
    }
  }

  // Save if requested
  if (doSave && allNewLeads.length > 0) {
    const merged = [...existingLeads, ...allNewLeads];
    fs.writeFileSync(LEADS_CACHE, JSON.stringify(merged, null, 2));
    console.log(`\n💾 Saved ${merged.length} total leads to ${path.basename(LEADS_CACHE)}`);
  } else if (!doSave && allNewLeads.length > 0) {
    console.log(`\n⚠️  Dry run: add --save to actually import these leads`);
  }
}

main();
