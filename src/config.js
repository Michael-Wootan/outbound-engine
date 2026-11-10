'use strict';
/**
 * config.js: everything company-specific lives in env vars and config/*.json,
 * so the scripts carry no hardcoded names, domains, segments or copy.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true, quiet: true });

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const STATE_DIR  = process.env.STATE_DIR  || path.join(ROOT, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// config/<name>.json wins; the committed <name>.example.json is the fallback
function loadConfig(name) {
  for (const file of [`${name}.json`, `${name}.example.json`]) {
    const p = path.join(CONFIG_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(`Missing ${path.join(CONFIG_DIR, name + '.json')}`);
}

const company  = loadConfig('company');
const segments = loadConfig('segments');
const warmupConversations = loadConfig('warmup-conversations');

// Never email our own domains
const internalDomains = (company.internalDomains || []).map(d => d.toLowerCase());
function isInternal(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  return internalDomains.some(d => domain === d || domain.endsWith('.' + d));
}

module.exports = { ROOT, CONFIG_DIR, STATE_DIR, company, segments, warmupConversations, isInternal };
