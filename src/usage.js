'use strict';
/**
 * Data layer: find the Claude OAuth token wherever the OS keeps it, ask the
 * official usage endpoint, and turn the answer into gauges ready to display.
 *
 * The token is never copied, never cached on disk, and never sent anywhere
 * other than api.anthropic.com.
 *
 * Ported from Claude-Marge-Widget (MIT, Ulrich Rozier), with one addition:
 * the CLAUDE_CODE_OAUTH_TOKEN environment variable is honored, because
 * setups that use it have no Keychain entry at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const API_HOST = 'api.anthropic.com';
const API_PATH = '/api/oauth/usage';
const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

// The Keychain service name changed between Claude Code releases. Try the
// current one, then the older one, rather than assuming which is installed.
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'];

/**
 * Read Claude Code's credentials. Environment first (those setups have no
 * Keychain entry), then Keychain on macOS, then the credentials file — which
 * in practice is a Linux path: fresh macOS logins write only to the Keychain.
 * A locked or denied Keychain is treated exactly like a missing entry; the
 * permissive ACL that makes silent reads possible today may well tighten.
 */
async function readCredentials() {
  const envToken = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  if (envToken) return { accessToken: envToken };

  if (process.platform === 'darwin') {
    for (const service of KEYCHAIN_SERVICES) {
      try {
        // Async on purpose: this runs on the Electron main process, and a
        // synchronous `security` call would freeze the cursor sampling and
        // every animation for its duration — worst case, a Keychain prompt.
        // Absolute path on purpose: npm prepends node_modules/.bin to PATH,
        // so a bare name could resolve to a dependency's binary and be handed
        // the argv for a credential read.
        const { stdout } = await execFileAsync('/usr/bin/security', [
          'find-generic-password', '-a', os.userInfo().username, '-w', '-s', service
        ], { encoding: 'utf8', timeout: 5000 });
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed.claudeAiOauth) return parsed.claudeAiOauth;
      } catch (_) {
        // No entry under this name, locked Keychain, or a read refused outside
        // a GUI session. Try the next name, then the file.
      }
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return parsed.claudeAiOauth || null;
  } catch (_) {
    return null;
  }
}

function httpsGetJson(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST,
      path: API_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'limen'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          // The endpoint tells us how long to wait when it throttles us.
          const after = parseInt(res.headers['retry-after'], 10);
          if (Number.isFinite(after)) err.retryAfter = after;
          return reject(err);
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** One {utilization, resets_at} block to a whole percentage, or null if absent. */
function pct(block) {
  if (!block || block.utilization === null || block.utilization === undefined) return null;
  return Math.max(0, Math.min(100, Math.round(block.utilization)));
}

/** Letter shown at the centre of a model's ring. */
function monogram(name) {
  const clean = String(name || '').trim();
  return clean ? clean[0].toUpperCase() : '?';
}

/**
 * Build the gauge list, in display order:
 *   1. the rolling 5 hour window, the one that cuts you off mid-task
 *   2. the weekly quota across all models
 *   3+. one gauge PER MODEL, because the quotas are not the same.
 *
 * The list is dynamic. An account exposing two limits shows two gauges, and a
 * missing limit is never rendered as a misleading zero.
 */
function normalize(raw) {
  const gauges = [];

  if (pct(raw.five_hour) !== null) {
    gauges.push({
      id: 'session',
      kind: 'session',
      icon: 'claude',
      percent: pct(raw.five_hour),
      resetsAt: raw.five_hour.resets_at,
      resetStyle: 'relative',
      active: false
    });
  }

  if (pct(raw.seven_day) !== null) {
    gauges.push({
      id: 'weekly',
      kind: 'weekly',
      icon: 'week',
      percent: pct(raw.seven_day),
      resetsAt: raw.seven_day.resets_at,
      resetStyle: 'absolute',
      active: false
    });
  }

  // One gauge per model, from either of the two shapes the API uses depending
  // on the account: seven_day_<model> blocks, and weekly_scoped entries.
  const seen = new Set();
  const addModel = (name, percent, resetsAt, active) => {
    const key = String(name).toLowerCase();
    if (percent === null || seen.has(key)) return;
    seen.add(key);
    gauges.push({
      id: `model-${key}`,
      kind: 'model',
      icon: 'model',
      monogram: monogram(name),
      model: name,
      percent,
      resetsAt,
      resetStyle: 'absolute',
      active: active === true
    });
  };

  // Every seven_day_* bucket, not a hardcoded pair. Anthropic ships new
  // surfaces, and a fixed list silently drops whatever it has not heard of.
  // Unrecognised keys are titled from the key itself; internal codenames are
  // hidden rather than shown to a user who would not recognise them.
  const KNOWN_MODELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
  for (const key of Object.keys(raw)) {
    if (!key.startsWith('seven_day_')) continue;
    const block = raw[key];
    if (!block || typeof block !== 'object' || pct(block) === null) continue;
    const slug = key.slice('seven_day_'.length);
    const name = KNOWN_MODELS[slug];
    if (!name) continue;
    addModel(name, pct(block), block.resets_at, false);
  }
  for (const limit of raw.limits || []) {
    const name = limit && limit.kind === 'weekly_scoped' && limit.scope && limit.scope.model
      ? limit.scope.model.display_name
      : null;
    if (name) addModel(name, pct({ utilization: limit.percent }), limit.resets_at, limit.is_active);
  }

  // The server grades its own limits. When it says a limit is past "normal",
  // trust it over our local thresholds — that keeps the tone scale correct
  // if Anthropic moves where the cliff is.
  for (const limit of raw.limits || []) {
    if (!limit || !limit.severity || limit.severity === 'normal') continue;
    const target = limit.kind === 'session' ? 'session'
      : limit.kind === 'weekly_all' ? 'weekly'
      : limit.scope && limit.scope.model
        ? `model-${String(limit.scope.model.display_name).toLowerCase()}`
        : null;
    const g = target && gauges.find((x) => x.id === target);
    if (g) g.severity = limit.severity;
  }

  // Which limit is biting right now: worth pointing out, it is the one that
  // will cut you off first.
  const activeLimit = (raw.limits || []).find((l) => l.is_active === true);
  if (activeLimit) {
    const group = activeLimit.kind === 'session' ? 'session'
      : activeLimit.kind === 'weekly_all' ? 'weekly' : null;
    const g = group && gauges.find((x) => x.id === group);
    if (g) g.active = true;
  }

  return {
    ok: true,
    fetchedAt: Date.now(),
    gauges,
    extraUsageEnabled: (raw.extra_usage || {}).is_enabled === true
  };
}

/** Turn a failed request into a state a human can act on. */
function reasonFor(err) {
  const status = err.status;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  if (status) return 'server';
  return 'network';
}

/**
 * Which plan the account is on, in words a person would use: "Max 20x",
 * "Max 5x", "Pro".
 *
 * Both fields are Claude Code's own vocabulary, not a documented API, and
 * they sit in the credentials blob we already read for the token — no extra
 * request, no new permission. `rateLimitTier` reads
 * "default_claude_max_20x"; the multiplier is pulled out by shape rather
 * than matched against a list, so a tier that does not exist yet still
 * reads correctly the day it ships.
 *
 * Nothing recognised means nothing shown. Printing "default_claude_max_20x"
 * at someone because we could not parse it is worse than staying quiet, and
 * setups running on CLAUDE_CODE_OAUTH_TOKEN have no tier at all.
 */
function planLabel(cred) {
  if (!cred) return '';
  const PLANS = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  const plan = PLANS[String(cred.subscriptionType || '').trim().toLowerCase()] || '';
  if (!plan) return '';
  // Only Max is sold in multiples; a "5x" on any other plan would be our
  // misreading of a string we do not own.
  if (plan !== 'Max') return plan;
  const tier = String(cred.rateLimitTier || '');
  const times = tier.match(/(\d{1,3})x\b/);
  return times ? `${plan} ${times[1]}x` : plan;
}

async function fetchUsage() {
  const cred = await readCredentials();
  if (!cred || !cred.accessToken) {
    return { ok: false, reason: 'no-credentials', fetchedAt: Date.now(), gauges: [] };
  }
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    // Claude Code refreshes this token on its own. We deliberately do not do
    // it for them: rotating the refresh token would invalidate their session.
    return { ok: false, reason: 'token-expired', fetchedAt: Date.now(), gauges: [] };
  }
  const plan = planLabel(cred);
  try {
    return { ...normalize(await httpsGetJson(cred.accessToken)), plan };
  } catch (err) {
    return {
      ok: false,
      reason: reasonFor(err),
      retryAfter: err.retryAfter,
      detail: err.message,
      fetchedAt: Date.now(),
      gauges: [],
      plan
    };
  }
}

module.exports = { fetchUsage, readCredentials, normalize, reasonFor, planLabel };

if (require.main === module) {
  // `--oneline` is for a tmux status bar, a shell prompt, or a Claude Code
  // statusline — the people who want the number without a widget at all.
  const oneline = process.argv.includes('--oneline');
  fetchUsage().then((r) => {
    if (!oneline) return console.log(JSON.stringify(r, null, 2));
    if (!r.ok) return console.log(`claude: ${r.reason}`);
    console.log(r.gauges
      .map((g) => `${g.kind === 'session' ? '5h' : g.kind === 'weekly' ? '7d' : g.model} ${g.percent}%`)
      .join('  '));
  });
}
