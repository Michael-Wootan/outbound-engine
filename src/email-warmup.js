#!/usr/bin/env node
'use strict';
/**
 * email-warmup.js: 21-day volume ramp for a new outreach domain
 *
 * A new sending domain should not go from zero to full cold volume overnight.
 * This script ramps it gradually between two mailboxes you own:
 *   1. Sends FROM the outreach domain TO your own second mailbox
 *   2. Replies FROM that mailbox BACK to the outreach domain
 *   3. Steps volume up over 21 days
 *   4. Rotates subjects and bodies from config/warmup-conversations.json
 *
 * Only your own mailboxes are involved. No third party receives warmup mail.
 *
 * Schedule:
 *   Day 1-5:    5 emails/day   (+ auto-replies)
 *   Day 6-10:  10 emails/day
 *   Day 11-15: 15 emails/day
 *   Day 16-21: 20 emails/day   (full cold outreach volume)
 *   Day 22+:   warmup complete, switch to cold-email-outreach.js
 *
 * Usage:
 *   node src/email-warmup.js                # Run today's warmup batch
 *   node src/email-warmup.js --status       # Check warmup progress
 *   node src/email-warmup.js --reset        # Reset warmup (start over)
 *
 * Env vars: see .env.example
 */

const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const { STATE_DIR, company, warmupConversations } = require('./config');

// ── Config ────────────────────────────────────────────────────────────────────
const OUTREACH_HOST = process.env.OUTREACH_SMTP_HOST;
const OUTREACH_PORT = parseInt(process.env.OUTREACH_SMTP_PORT || '587');
const OUTREACH_USER = process.env.OUTREACH_SMTP_USER;
const OUTREACH_PASS = process.env.OUTREACH_SMTP_PASS;
const OUTREACH_FROM = process.env.OUTREACH_FROM_EMAIL;
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD;
const EMAIL_NOTIFY  = process.env.EMAIL_NOTIFY || process.env.GMAIL_USER;
const SENDER_NAME   = process.env.SENDER_NAME || company.senderName;

const STATE_FILE = path.join(STATE_DIR, 'email-warmup-state.json');
const STATUS     = process.argv.includes('--status');
const RESET      = process.argv.includes('--reset');

// ── Warmup ramp schedule ──────────────────────────────────────────────────────
function getTargetVolume(dayNum) {
  if (dayNum <= 5)  return 5;
  if (dayNum <= 10) return 10;
  if (dayNum <= 15) return 15;
  if (dayNum <= 21) return 20;
  return 0; // warmup complete
}

// ── State management ──────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { startDate: new Date().toISOString().split('T')[0], totalSent: 0, totalReplied: 0, dailyLog: [] };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getDayNumber(state) {
  const start = new Date(state.startDate);
  const now = new Date();
  return Math.floor((now - start) / (24 * 60 * 60 * 1000)) + 1;
}

// ── Conversation pool ─────────────────────────────────────────────────────────
// Varied subjects and bodies, loaded from config/warmup-conversations.json
const WARMUP_CONVERSATIONS = warmupConversations;

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();

  if (RESET) {
    console.log('🔄 Resetting warmup state...');
    saveState({ startDate: new Date().toISOString().split('T')[0], totalSent: 0, totalReplied: 0, dailyLog: [] });
    console.log('✅ Reset complete. Warmup will start fresh on next run.');
    return;
  }

  const dayNum = getDayNumber(state);
  const target = getTargetVolume(dayNum);

  if (STATUS) {
    console.log('📊 Email Warmup Status');
    console.log('='.repeat(40));
    console.log(`  Start date:    ${state.startDate}`);
    console.log(`  Current day:   ${dayNum} of 21`);
    console.log(`  Today's target: ${target} emails`);
    console.log(`  Total sent:    ${state.totalSent}`);
    console.log(`  Total replies: ${state.totalReplied}`);
    console.log(`  Status:        ${dayNum > 21 ? '✅ WARMUP COMPLETE: ready for cold outreach!' : '🔥 Warming up...'}`);
    if (state.dailyLog.length > 0) {
      console.log('\n  Recent activity:');
      state.dailyLog.slice(-7).forEach(d => {
        console.log(`    Day ${d.day}: ${d.sent} sent, ${d.replied} replies`);
      });
    }
    return;
  }

  console.log(`🔥 Email Domain Warmup: Day ${dayNum} of 21`);
  console.log('='.repeat(40));

  if (dayNum > 21) {
    console.log('✅ Warmup complete! Your domain has 21 days of reputation.');
    console.log('   You can now switch to cold-email-outreach.js for live outreach.');
    return;
  }

  if (target === 0) {
    console.log('Nothing to do today.');
    return;
  }

  if (!OUTREACH_HOST || !GMAIL_USER) {
    throw new Error('Missing SMTP config: need both OUTREACH_SMTP_* and GMAIL_* env vars');
  }

  console.log(`  Target: ${target} email round-trips today`);
  console.log(`  From: ${OUTREACH_FROM} ↔ ${EMAIL_NOTIFY}\n`);

  // Create transporters
  const outreachTransport = nodemailer.createTransport({
    host: OUTREACH_HOST, port: OUTREACH_PORT, secure: false,
    auth: { user: OUTREACH_USER, pass: OUTREACH_PASS },
  });

  const gmailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  let sent = 0, replied = 0, errors = 0;

  for (let i = 0; i < target; i++) {
    // Pick a random conversation
    const convo = WARMUP_CONVERSATIONS[randomBetween(0, WARMUP_CONVERSATIONS.length)];

    try {
      // Step 1: Send FROM outreach domain TO Gmail
      console.log(`  📤 [${i + 1}/${target}] Sending: "${convo.subject}"`);
      await outreachTransport.sendMail({
        from: `"${SENDER_NAME}" <${OUTREACH_FROM}>`,
        to: EMAIL_NOTIFY,
        subject: convo.subject,
        text: convo.outgoing + '\n\n' + company.signature,
      });
      sent++;

      // Wait 30-90 seconds (simulates reading the email)
      const readDelay = randomBetween(30, 90);
      console.log(`  ⏱️  Waiting ${readDelay}s (simulating read time)...`);
      await sleep(readDelay * 1000);

      // Step 2: Reply FROM Gmail BACK to outreach domain
      console.log(`  📥 Replying from Gmail...`);
      await gmailTransport.sendMail({
        from: GMAIL_USER,
        to: OUTREACH_FROM,
        subject: `Re: ${convo.subject}`,
        text: convo.reply,
        inReplyTo: `<warmup-${Date.now()}@${OUTREACH_FROM.split('@')[1]}>`,
      });
      replied++;

      // Wait 2-5 minutes between conversations to look natural
      if (i < target - 1) {
        const gapMinutes = randomBetween(2, 5);
        console.log(`  ⏱️  Waiting ${gapMinutes} min before next conversation...\n`);
        await sleep(gapMinutes * 60 * 1000);
      }

    } catch (e) {
      console.log(`  ❌ Error on email ${i + 1}: ${e.message}`);
      errors++;
    }
  }

  // Update state
  state.totalSent += sent;
  state.totalReplied += replied;
  state.dailyLog.push({
    date: new Date().toISOString().split('T')[0],
    day: dayNum,
    sent,
    replied,
    errors,
    target,
  });
  saveState(state);

  console.log(`\n${'='.repeat(40)}`);
  console.log(`✅ Day ${dayNum}: ${sent} sent, ${replied} replies, ${errors} errors`);
  console.log(`📊 Running total: ${state.totalSent} sent, ${state.totalReplied} replies`);

  if (dayNum >= 21) {
    console.log('\n🎉 WARMUP COMPLETE! Domain is ready for cold outreach.');
  } else {
    console.log(`\n📅 Next: Day ${dayNum + 1}: ${getTargetVolume(dayNum + 1)} emails`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
