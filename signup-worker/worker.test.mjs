// node --test signup-worker/worker.test.mjs: the signup API stores, dedupes,
// unsubscribes and rate-limits, with an in-memory fake for the db adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker, {
  createHandler,
  createScheduledHandler,
  d1Db,
  retryUnforwardedSupport,
  supportRetryDelayMs,
  SUPPORT_RETRY_BATCH,
  SUPPORT_RETRY_MAX_ATTEMPTS,
  SUPPORT_RETRY_BASE_MS,
  SUPPORT_RETRY_MAX_DELAY_MS,
  THANKS_URL,
  safeBackLink,
  escHtml,
  safeHtml,
  pageResponse,
  MAX_BODY_BYTES,
} from './src/worker.js';

function fakeDb() {
  const rows = new Map();
  const byToken = new Map();
  const hits = new Map();
  const key = (email, kind, topic) => `${email}|${kind}|${topic ?? ''}`;
  return {
    rows,
    byToken,
    hits,
    async getSignup(email, kind, topic) {
      return rows.get(key(email, kind, topic)) || null;
    },
    async insertSignup(row) {
      const full = { ...row, unsubscribed_at: null };
      rows.set(key(row.email, row.kind, row.topic), full);
      byToken.set(row.token, full);
    },
    async updateSignup(row) {
      const full = rows.get(key(row.email, row.kind, row.topic));
      full.remark = row.remark;
      full.source_page = row.source_page;
      full.unsubscribed_at = null;
    },
    async rateHit(ip, window) {
      const k = `${ip}|${window}`;
      const next = (hits.get(k) || 0) + 1;
      hits.set(k, next);
      return next;
    },
    async pruneRateLimits(cutoff) {
      for (const [k] of hits) {
        const parts = k.split('|');
        const win = Number(parts[1]);
        if (win < cutoff) {
          hits.delete(k);
        }
      }
    },
    async getByToken(token) {
      return byToken.get(token) || null;
    },
    async markUnsubscribed(token) {
      const row = byToken.get(token);
      if (row) row.unsubscribed_at = '2026-10-27T00:00:00.000Z';
    },
    supportRows: [],
    async insertSupportMessage(row) {
      const full = { ...row, id: this.supportRows.length + 1, forwarded_at: null };
      this.supportRows.push(full);
      return full.id;
    },
    async markSupportForwarded(id) {
      const row = this.supportRows.find((r) => r.id === id);
      if (row) row.forwarded_at = '2026-11-20T00:00:00.000Z';
    },
    async recordSupportForwardFailure(id, status, nextAt) {
      const row = this.supportRows.find((r) => r.id === id);
      if (row) {
        row.forward_attempts = (row.forward_attempts || 0) + 1;
        row.forward_last_status = status;
        row.next_forward_at = nextAt;
      }
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://api.blowhorn.ai${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function formPost(path, fields) {
  const params = new URLSearchParams(fields);
  return new Request(`https://api.blowhorn.ai${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

test('waitlist signup stores one row, lowercased and trimmed', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(
    post('/api/waitlist', { email: '  Alex@Example.com ', topic: 'tiktok', remark: 'shorts', source_page: '/docs/reference/platforms/tiktok/' }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const row = await db.getSignup('alex@example.com', 'waitlist', 'tiktok');
  assert.equal(row.remark, 'shorts');
  assert.equal(row.topic, 'tiktok');
  assert.equal(row.source_page, '/docs/reference/platforms/tiktok/');
  assert.ok(row.token.length >= 32);
});

test('newsletter signup has no topic and never touches the waitlist', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/subscribe', { email: 'alex@example.com' }));
  const row = await db.getSignup('alex@example.com', 'newsletter', null);
  assert.equal(row.kind, 'newsletter');
  assert.equal(row.topic, null);
  assert.equal(await db.getSignup('alex@example.com', 'waitlist', null), null);
});

test('signing up twice refreshes the remark instead of adding a row', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'a@b.co', topic: 'tiktok', remark: 'first' }));
  await handle(post('/api/waitlist', { email: 'a@b.co', topic: 'tiktok', remark: 'second' }));
  assert.equal(db.rows.size, 1);
  assert.equal((await db.getSignup('a@b.co', 'waitlist', 'tiktok')).remark, 'second');
});

test('re-signup after unsubscribe clears the unsubscribe', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'a@b.co', topic: 'tiktok' }));
  const row = await db.getSignup('a@b.co', 'waitlist', 'tiktok');
  await handle(formPost('/api/unsubscribe', { token: row.token }));
  assert.ok((await db.getSignup('a@b.co', 'waitlist', 'tiktok')).unsubscribed_at);
  await handle(post('/api/waitlist', { email: 'a@b.co', topic: 'tiktok' }));
  assert.equal((await db.getSignup('a@b.co', 'waitlist', 'tiktok')).unsubscribed_at, null);
});

test('invalid email, bad topic and long remark are 400s and store nothing', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  for (const body of [
    { email: 'not-an-email', topic: 'tiktok' },
    { email: 'a@b.co', topic: 'TikTok!' },
    { email: 'a@b.co', topic: 'tiktok', remark: 'x'.repeat(501) },
  ]) {
    const res = await handle(post('/api/waitlist', body));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  }
  assert.equal(db.rows.size, 0);
});

test('honeypot answers success without storing', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(
    post('/api/waitlist', { email: 'bot@spam.test', topic: 'tiktok', website: 'http://spam' }),
  );
  assert.equal(res.status, 200);
  assert.equal(db.rows.size, 0);
});

test('form posts redirect to the thanks page on success', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(
    formPost('/api/waitlist', { email: 'a@b.co', topic: 'tiktok' }),
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), THANKS_URL);
});

test('unsubscribe without a token says the link is incomplete', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(new Request('https://api.blowhorn.ai/api/unsubscribe'));
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /incomplete/);
  assert.doesNotMatch(text, /You are unsubscribed/);
});

test('unsubscribe with an unknown token says the link is not recognized', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(new Request('https://api.blowhorn.ai/api/unsubscribe?token=nope'));
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.match(text, /not recognized/);
  assert.doesNotMatch(text, /You are unsubscribed/);
});

test('31st request in a minute is rate limited', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  let last;
  for (let i = 0; i < 31; i++) {
    last = await handle(post('/api/subscribe', { email: `u${i}@b.co` }, { 'cf-connecting-ip': '203.0.113.7' }));
  }
  assert.equal(last.status, 429);
});

test('unknown paths are 404 without touching the store', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(new Request('https://api.blowhorn.ai/api/nope'));
  assert.equal(res.status, 404);
  assert.equal(db.rows.size, 0);
});

test('GET /api/unsubscribe renders confirmation without mutating state', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'user@example.com', topic: 'tiktok' }));
  const row = await db.getSignup('user@example.com', 'waitlist', 'tiktok');

  const res = await handle(new Request(`https://api.blowhorn.ai/api/unsubscribe?token=${row.token}`));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Confirm unsubscribe/);

  const refreshed = await db.getByToken(row.token);
  assert.equal(refreshed.unsubscribed_at, null);
});

test('POST /api/unsubscribe marks the subscriber as unsubscribed', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'user@example.com', topic: 'tiktok' }));
  const row = await db.getSignup('user@example.com', 'waitlist', 'tiktok');

  const res = await handle(formPost('/api/unsubscribe', { token: row.token }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /You are unsubscribed/);

  const refreshed = await db.getByToken(row.token);
  assert.ok(refreshed.unsubscribed_at);
});

test('POST /api/unsubscribe with missing or unknown token returns 400 or 404', async () => {
  const db = fakeDb();
  const handle = createHandler(db);

  const resMissing = await handle(new Request('https://api.blowhorn.ai/api/unsubscribe', { method: 'POST' }));
  assert.equal(resMissing.status, 400);
  assert.match(await resMissing.text(), /incomplete/);

  const resUnknown = await handle(formPost('/api/unsubscribe', { token: 'nope' }));
  assert.equal(resUnknown.status, 404);
  assert.match(await resUnknown.text(), /not recognized/);
});

test('POST /api/unsubscribe is safe to repeat', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'user@example.com', topic: 'tiktok' }));
  const row = await db.getSignup('user@example.com', 'waitlist', 'tiktok');

  const first = await handle(formPost('/api/unsubscribe', { token: row.token }));
  assert.equal(first.status, 200);

  const second = await handle(formPost('/api/unsubscribe', { token: row.token }));
  assert.equal(second.status, 200);
  assert.match(await second.text(), /You are unsubscribed/);
});

test('GET /api/unsubscribe on an already unsubscribed token shows unsubscribed', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  await handle(post('/api/waitlist', { email: 'user@example.com', topic: 'tiktok' }));
  const row = await db.getSignup('user@example.com', 'waitlist', 'tiktok');
  await handle(formPost('/api/unsubscribe', { token: row.token }));

  const res = await handle(new Request(`https://api.blowhorn.ai/api/unsubscribe?token=${row.token}`));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /You are unsubscribed/);
});

test('GET /api/unsubscribe with missing or unknown token returns 400 or 404', async () => {
  const db = fakeDb();
  const handle = createHandler(db);

  const resMissing = await handle(new Request('https://api.blowhorn.ai/api/unsubscribe'));
  assert.equal(resMissing.status, 400);
  assert.match(await resMissing.text(), /incomplete/);

  const resUnknown = await handle(new Request('https://api.blowhorn.ai/api/unsubscribe?token=nope'));
  assert.equal(resUnknown.status, 404);
  assert.match(await resUnknown.text(), /not recognized/);
});

test('safeBackLink accepts clean relative paths and rejects attribute-breaking or external inputs', () => {
  assert.equal(safeBackLink('/pricing/'), 'https://blowhorn.ai/pricing/');
  assert.equal(safeBackLink('/docs/reference/platforms/x/'), 'https://blowhorn.ai/docs/reference/platforms/x/');
  assert.equal(safeBackLink('//evil.com'), 'https://blowhorn.ai');
  assert.equal(safeBackLink('/\\evil.com'), 'https://blowhorn.ai');
  assert.equal(safeBackLink('/" onmouseover="alert(1)'), 'https://blowhorn.ai');
  assert.equal(safeBackLink("/' onmouseover='alert(1)"), 'https://blowhorn.ai');
  assert.equal(safeBackLink('/path with spaces'), 'https://blowhorn.ai');
  assert.equal(safeBackLink('/path<script>'), 'https://blowhorn.ai');
  assert.equal(safeBackLink('https://evil.com'), 'https://blowhorn.ai');
  assert.equal(safeBackLink(null), 'https://blowhorn.ai');
  assert.equal(safeBackLink(undefined), 'https://blowhorn.ai');
});

test('form post error escapes HTML and protects Go back link from attribute injection', async () => {
  const db = fakeDb();
  const handle = createHandler(db);

  // Clean path produces correct link
  const resClean = await handle(formPost('/api/waitlist', {
    email: 'bad-email',
    topic: 'tiktok',
    source_page: '/docs/reference/',
  }));
  assert.equal(resClean.status, 400);
  const textClean = await resClean.text();
  assert.match(textClean, /<a href="https:\/\/blowhorn\.ai\/docs\/reference\/">Go back<\/a>/);

  // Malicious path cannot break out of href attribute
  const resMalicious = await handle(formPost('/api/waitlist', {
    email: 'bad-email',
    topic: 'tiktok',
    source_page: '/" onmouseover="alert(1)',
  }));
  assert.equal(resMalicious.status, 400);
  const textMalicious = await resMalicious.text();
  assert.doesNotMatch(textMalicious, /onmouseover/);
  assert.match(textMalicious, /<a href="https:\/\/blowhorn\.ai">Go back<\/a>/);
});

test('pageResponse structurally escapes title and plain body, preserving safeHtml', async () => {
  const req = new Request('https://api.blowhorn.ai/api/test');

  // Plain strings in title and body are escaped by default
  const resPlain = pageResponse(req, 400, 'Alert <script>', 'Error & "quotes"');
  const textPlain = await resPlain.text();
  assert.match(textPlain, /<title>Alert &lt;script&gt;<\/title>/);
  assert.match(textPlain, /<h1>Alert &lt;script&gt;<\/h1>/);
  assert.match(textPlain, /<p>Error &amp; &quot;quotes&quot;<\/p>/);

  // safeHtml wrapper is preserved for trusted markup
  const resHtml = pageResponse(req, 200, 'Clean Title', safeHtml('<b>formatted</b>'));
  const textHtml = await resHtml.text();
  assert.match(textHtml, /<title>Clean Title<\/title>/);
  assert.match(textHtml, /<p><b>formatted<\/b><\/p>/);
});

test('rate limiter failure on GET /api/unsubscribe returns HTML error page', async () => {
  const db = fakeDb();
  db.rateHit = async () => {
    throw new Error('D1 connection failure');
  };
  const handle = createHandler(db);

  const res = await handle(new Request('https://api.blowhorn.ai/api/unsubscribe?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'));
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const text = await res.text();
  assert.match(text, /Something went wrong/);
  assert.match(text, /Try again shortly/);
  assert.doesNotMatch(text, /{"ok":false/);
});

test('rate limiter failure on other requests retains existing response behavior', async () => {
  const db = fakeDb();
  db.rateHit = async () => {
    throw new Error('D1 connection failure');
  };
  const handle = createHandler(db);

  // Normal JSON signup request returns JSON 500
  const jsonRes = await handle(post('/api/subscribe', { email: 'user@example.com' }));
  assert.equal(jsonRes.status, 500);
  assert.equal(jsonRes.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await jsonRes.json(), { ok: false, error: 'Something went wrong.' });

  // Unsubscribe POST form request returns HTML 500 form error page
  const formRes = await handle(formPost('/api/unsubscribe', { token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }));
  assert.equal(formRes.status, 500);
  assert.equal(formRes.headers.get('content-type'), 'text/html; charset=utf-8');
  const formText = await formRes.text();
  assert.match(formText, /Something went wrong/);
  assert.match(formText, /Go back/);
});

test('signup responses include security headers for MIME, frame and referrer protection', async () => {
  const handler = createHandler(fakeDb());

  // JSON API response
  const jsonRes = await handler(post('/api/newsletter', {
    email: 'valid@example.com',
  }));
  assert.equal(jsonRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(jsonRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(jsonRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

  // HTML page response (e.g. 400 error page)
  const errRes = await handler(formPost('/api/newsletter', {
    email: 'invalid-email',
  }));
  assert.equal(errRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(errRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(errRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

  // 404 response
  const notFoundRes = await handler(new Request('https://api.blowhorn.ai/unknown'));
  assert.equal(notFoundRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(notFoundRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(notFoundRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

  // OPTIONS preflight response
  const optionsRes = await handler(new Request('https://api.blowhorn.ai/api/waitlist', { method: 'OPTIONS' }));
  assert.equal(optionsRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(optionsRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(optionsRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('rateHit does not delete expired rate limits during normal request handling', async () => {
  const db = fakeDb();
  // Manually pre-seed expired buckets in fakeDb
  db.hits.set('203.0.113.10|100', 5);
  db.hits.set('203.0.113.10|101', 12);

  const handle = createHandler(db);
  // Execute a normal request in a later minute window
  const res = await handle(post('/api/subscribe', { email: 'fresh@example.com' }, { 'cf-connecting-ip': '203.0.113.10' }));
  assert.equal(res.status, 200);

  // Past buckets must still exist because rateHit no longer executes cleanup
  assert.equal(db.hits.get('203.0.113.10|100'), 5);
  assert.equal(db.hits.get('203.0.113.10|101'), 12);
});

test('scheduled cleanup prunes expired buckets while preserving active and future buckets', async () => {
  const db = fakeDb();
  const scheduledTime = 60000000; // window 1000 exactly
  const currentWindow = Math.floor(scheduledTime / 60000); // 1000

  // Pre-seed hits across past, current, and future windows
  db.hits.set(`192.0.2.1|${currentWindow - 2}`, 10);
  db.hits.set(`192.0.2.1|${currentWindow - 1}`, 15);
  db.hits.set(`192.0.2.1|${currentWindow}`, 8);
  db.hits.set(`192.0.2.1|${currentWindow + 1}`, 3);

  const scheduledHandler = createScheduledHandler(db);
  await scheduledHandler({ scheduledTime });

  // Expired buckets (window < currentWindow) must be deleted
  assert.equal(db.hits.has(`192.0.2.1|${currentWindow - 2}`), false);
  assert.equal(db.hits.has(`192.0.2.1|${currentWindow - 1}`), false);

  // Active bucket (window === currentWindow) must survive
  assert.equal(db.hits.get(`192.0.2.1|${currentWindow}`), 8);

  // Future bucket (window > currentWindow) must survive
  assert.equal(db.hits.get(`192.0.2.1|${currentWindow + 1}`), 3);
});

test('scheduled cleanup falls back to clock when event scheduledTime is missing or invalid', async () => {
  const db = fakeDb();
  const simulatedNow = 120000000; // window 2000
  const currentWindow = Math.floor(simulatedNow / 60000); // 2000

  db.hits.set(`192.0.2.2|${currentWindow - 1}`, 4);
  db.hits.set(`192.0.2.2|${currentWindow}`, 7);

  const scheduledHandler = createScheduledHandler(db, () => simulatedNow);
  // Pass empty event without scheduledTime
  await scheduledHandler({});

  assert.equal(db.hits.has(`192.0.2.2|${currentWindow - 1}`), false);
  assert.equal(db.hits.get(`192.0.2.2|${currentWindow}`), 7);
});

test('worker.scheduled delegates to createScheduledHandler and binds env.SIGNUPS_DB', async () => {
  let prunedCutoff = null;
  const mockD1 = {
    prepare(sql) {
      return {
        bind(cutoff) {
          return {
            async run() {
              prunedCutoff = cutoff;
              return { success: true };
            },
          };
        },
      };
    },
  };

  const env = { SIGNUPS_DB: mockD1 };
  const scheduledTime = 180000000; // window 3000
  await worker.scheduled({ scheduledTime }, env);

  assert.equal(prunedCutoff, 3000);
});

test('scheduled cleanup failure does not compromise normal request handling', async () => {
  const failingDb = fakeDb();
  failingDb.pruneRateLimits = async () => {
    throw new Error('D1 transient failure');
  };

  const scheduledHandler = createScheduledHandler(failingDb);
  await assert.rejects(
    async () => {
      await scheduledHandler({ scheduledTime: Date.now() });
    },
    /D1 transient failure/,
  );

  // Normal request handling remains fully operational
  const handle = createHandler(failingDb);
  const res = await handle(post('/api/subscribe', { email: 'user@example.com' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('real SQLite schema: migrations apply, window index is used, and d1Db pruning preserves active bucket', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const m1 = readFileSync(join(__dirname, 'migrations', '0001_init.sql'), 'utf8');
  const m2 = readFileSync(join(__dirname, 'migrations', '0002_rate_limits_window_idx.sql'), 'utf8');

  sqlite.exec(m1);
  sqlite.exec(m2);

  // Verify that DELETE query uses the secondary index on window
  const queryPlan = sqlite.prepare('EXPLAIN QUERY PLAN DELETE FROM rate_limits WHERE window < 1000').all();
  const planDetail = queryPlan.map((step) => step.detail).join(' ');
  assert.match(planDetail, /USING INDEX idx_rate_limits_window/);

  // Wrap DatabaseSync into the D1 interface expected by d1Db
  const d1Shim = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            first() {
              return stmt.get(...params) || null;
            },
            run() {
              stmt.run(...params);
              return { success: true };
            },
            all() {
              return { results: stmt.all(...params) };
            },
          };
        },
      };
    },
  };

  const db = d1Db(d1Shim);
  const currentWindow = 500;

  // Record rate limits for expired, active, and future windows
  await db.rateHit('192.0.2.1', currentWindow - 2);
  await db.rateHit('192.0.2.1', currentWindow - 1);
  await db.rateHit('192.0.2.1', currentWindow);
  await db.rateHit('192.0.2.1', currentWindow); // count = 2
  await db.rateHit('192.0.2.1', currentWindow + 1);

  // Prune with cutoff equal to currentWindow
  await db.pruneRateLimits(currentWindow);

  const remaining = sqlite.prepare('SELECT window, count FROM rate_limits ORDER BY window ASC').all();
  assert.equal(remaining.length, 2);

  // Active bucket must survive with intact count
  assert.equal(remaining[0].window, currentWindow);
  assert.equal(remaining[0].count, 2);

  // Future bucket must survive
  assert.equal(remaining[1].window, currentWindow + 1);
  assert.equal(remaining[1].count, 1);
});

test('oversized Content-Length on JSON POST returns 413 and stores nothing', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const req = new Request('https://api.blowhorn.ai/api/waitlist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '15000',
    },
    body: JSON.stringify({ email: 'oversized@example.com', topic: 'shorts' }),
  });
  const res = await handler(req);
  assert.equal(res.status, 413);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.error, 'Payload too large.');
  assert.equal(db.rows.size, 0);
});

test('oversized Content-Length on form POST returns 413 HTML error page and preserves safeBackLink', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const params = new URLSearchParams({ email: 'oversized@example.com', source_page: '/coming-soon/' });
  const req = new Request('https://api.blowhorn.ai/api/waitlist', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '15000',
    },
    body: params.toString(),
  });
  const res = await handler(req);
  assert.equal(res.status, 413);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const html = await res.text();
  assert.match(html, /<title>Payload too large<\/title>/);
  assert.match(html, /Payload too large\./);
  assert.match(html, /<a href="https:\/\/blowhorn\.ai">Go back<\/a>/);
  assert.equal(db.rows.size, 0);
});

test('oversized raw body without Content-Length header returns 413', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const oversizedData = 'x'.repeat(MAX_BODY_BYTES + 1);
  const req = new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'valid@example.com', remark: oversizedData }),
  });
  const res = await handler(req);
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.error, 'Payload too large.');
  assert.equal(db.rows.size, 0);
});

test('boundary payload at exactly MAX_BODY_BYTES passes size check to validation', async () => {
  const db = fakeDb();
  const handler = createHandler(db);

  // Exact boundary: payload length equals MAX_BODY_BYTES
  const base = JSON.stringify({ email: 'test@example.com', remark: '' });
  const padLen = MAX_BODY_BYTES - new TextEncoder().encode(base).length;
  const atLimitBody = JSON.stringify({ email: 'test@example.com', remark: 'a'.repeat(padLen) });
  assert.equal(new TextEncoder().encode(atLimitBody).length, MAX_BODY_BYTES);

  const reqAtLimit = new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: atLimitBody,
  });
  const resAtLimit = await handler(reqAtLimit);
  // Passes size check (not 413), fails field validation because remark is > 500 chars (400)
  assert.equal(resAtLimit.status, 400);
  const dataAtLimit = await resAtLimit.json();
  assert.match(dataAtLimit.error, /remark is too long/);

  // One byte over MAX_BODY_BYTES: rejected immediately by size check with 413
  const overLimitBody = atLimitBody + ' ';
  assert.equal(new TextEncoder().encode(overLimitBody).length, MAX_BODY_BYTES + 1);
  const reqOverLimit = new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: overLimitBody,
  });
  const resOverLimit = await handler(reqOverLimit);
  assert.equal(resOverLimit.status, 413);
  const dataOverLimit = await resOverLimit.json();
  assert.equal(dataOverLimit.error, 'Payload too large.');
});

test('JSON array, primitive or malformed body returns 400 without crashing', async () => {
  const db = fakeDb();
  const handler = createHandler(db);

  // Array body
  const resArray = await handler(new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(['not', 'an', 'object']),
  }));
  assert.equal(resArray.status, 400);
  const dataArray = await resArray.json();
  assert.equal(dataArray.error, 'Could not read the signup.');

  // Primitive string body
  const resString = await handler(new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('plain string'),
  }));
  assert.equal(resString.status, 400);

  // Malformed JSON syntax
  const resMalformed = await handler(new Request('https://api.blowhorn.ai/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid json',
  }));
  assert.equal(resMalformed.status, 400);
});

test('oversized payload on POST /api/unsubscribe returns 413', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const req = new Request('https://api.blowhorn.ai/api/unsubscribe', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '15000',
    },
    body: new URLSearchParams({ token: 'testtoken' }).toString(),
  });
  const res = await handler(req);
  assert.equal(res.status, 413);
});

test('valid multipart form submission is parsed and redirects', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const fd = new FormData();
  fd.append('email', 'multipart@example.com');
  fd.append('topic', 'tiktok');
  fd.append('remark', 'testing multipart');
  const req = new Request('https://api.blowhorn.ai/api/waitlist', {
    method: 'POST',
    body: fd,
  });
  const res = await handler(req);
  assert.equal(res.status, 303);
  const row = await db.getSignup('multipart@example.com', 'waitlist', 'tiktok');
  assert.ok(row);
  assert.equal(row.remark, 'testing multipart');
});

test('oversized chunked multipart/form-data returns 413', async () => {
  const db = fakeDb();
  const handler = createHandler(db);
  const fd = new FormData();
  fd.append('email', 'oversized-multipart@example.com');
  fd.append('remark', 'x'.repeat(MAX_BODY_BYTES + 1));
  const rawReq = new Request('https://api.blowhorn.ai/api/waitlist', {
    method: 'POST',
    body: fd,
  });
  const text = await rawReq.text();
  // Strip content-length to simulate a chunked transfer
  const headers = new Headers(rawReq.headers);
  headers.delete('content-length');
  const req = new Request('https://api.blowhorn.ai/api/waitlist', {
    method: 'POST',
    headers,
    body: text,
  });
  const res = await handler(req);
  assert.equal(res.status, 413);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await res.text();
  assert.match(html, /Payload too large/);
  assert.equal(db.rows.size, 0);
});

function supportBody(overrides = {}) {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    subject: 'Cannot sign in',
    message: 'The app refuses my profile.',
    details: 'blowhorn login\nexit code 3',
    source_page: '/support/',
    ...overrides,
  };
}

test('support message stores one row and creates the durable case', async () => {
  const db = fakeDb();
  const calls = [];
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 201 };
    },
  };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.supportRows.length, 1);
  const row = db.supportRows[0];
  assert.equal(row.name, 'Ada Lovelace');
  assert.equal(row.email, 'ada@example.com');
  assert.match(row.case_number, /^[0-9a-f-]{36}$/);
  assert.equal(row.subject, `Feedback [${row.case_number}]`);
  assert.equal(row.details, 'blowhorn login\nexit code 3');
  assert.equal(row.source_page, '/support/');
  assert.match(row.creation_proof, /^[0-9a-f]{64}$/);
  assert.ok(row.forwarded_at);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, forward.url);
  assert.equal(calls[0].headers['x-client-key'], 'website-key');
  assert.equal(calls[0].headers['x-support-creation-proof'], row.creation_proof);
  assert.equal(calls[0].body.caseId, row.case_number);
  assert.equal(calls[0].body.reason, 'feedback');
  assert.equal(calls[0].body.contactPreference, 'reply');
  assert.equal(calls[0].body.email, 'ada@example.com');
  assert.equal(calls[0].body.name, 'Ada Lovelace');
  assert.match(calls[0].body.message, /The app refuses my profile\./);
  assert.match(calls[0].body.message, /exit code 3/);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['caseId', 'contactPreference', 'email', 'message', 'name', 'reason']);
});

test('an identical-payload replay (200) also marks the row forwarded', async () => {
  const db = fakeDb();
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.ok(db.supportRows[0].forwarded_at);
});

test('a payload conflict (409) leaves the row unforwarded for investigation', async () => {
  const db = fakeDb();
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async () => ({ ok: false, status: 409 }),
  };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.equal(db.supportRows[0].forwarded_at, null);
});

test('a configured URL without the client key stores only', async () => {
  const db = fakeDb();
  let called = 0;
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: '',
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 201 };
    },
  };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.equal(called, 0);
  assert.equal(db.supportRows[0].forwarded_at, null);
});

test('support form post redirects to the support thanks page', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(formPost('/api/support', supportBody()));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://blowhorn.ai/support/thanks/');
  assert.equal(db.supportRows.length, 1);
});

test('support validation rejects missing and over-long fields', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  for (const body of [
    supportBody({ name: 'x'.repeat(101) }),
    supportBody({ email: 'not-an-email' }),
    supportBody({ message: '' }),
    supportBody({ message: 'x'.repeat(5001) }),
    supportBody({ details: 'x'.repeat(5001) }),
  ]) {
    const res = await handle(post('/api/support', body));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  }
  assert.equal(db.supportRows.length, 0);
});

test('support honeypot answers success without storing or forwarding', async () => {
  const db = fakeDb();
  let called = 0;
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 201 };
    },
  };
  const res = await createHandler(db, { forward })(
    post('/api/support', supportBody({ website: 'http://spam' })),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.supportRows.length, 0);
  assert.equal(called, 0);
  const formRes = await createHandler(db, { forward })(
    formPost('/api/support', supportBody({ website: 'http://spam' })),
  );
  assert.equal(formRes.status, 303);
  assert.equal(db.supportRows.length, 0);
});

test('a failed forward keeps the row and leaves forwarded_at null', async () => {
  const db = fakeDb();
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.equal(db.supportRows.length, 1);
  assert.equal(db.supportRows[0].forwarded_at, null);
  const throwing = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  };
  const res2 = await createHandler(db, { forward: throwing })(
    post('/api/support', supportBody({ email: 'b@example.com' })),
  );
  assert.equal(res2.status, 200);
  assert.equal(db.supportRows.length, 2);
  assert.equal(db.supportRows[1].forwarded_at, null);
});

test('no forward configured stores only', async () => {
  const db = fakeDb();
  const res = await createHandler(db, { forward: null })(post('/api/support', supportBody()));
  assert.equal(res.status, 200);
  assert.equal(db.supportRows.length, 1);
  assert.equal(db.supportRows[0].forwarded_at, null);
});

test('the forward sends the full name as typed', async () => {
  const db = fakeDb();
  const calls = [];
  const forward = {
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 400 };
    },
  };
  await createHandler(db, { forward })(post('/api/support', supportBody({ name: 'Madonna' })));
  assert.equal(calls[0].name, 'Madonna');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['caseId', 'contactPreference', 'email', 'message', 'name', 'reason']);
  assert.equal(db.supportRows[0].forwarded_at, null);
});

test('support shares the per-IP rate limit', async () => {
  const db = fakeDb();
  const handle = createHandler(db);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await handle(post('/api/support', supportBody(), { 'cf-connecting-ip': '203.0.113.9' }));
  }
  assert.equal(last.status, 429);
  assert.equal(db.supportRows.length, 30);
});


test('anonymous choice discards contact fields before storage and forwarding', async () => {
  const db = fakeDb();
  let payload;
  const forward = { url: 'https://cloud.example.test/api/support/cases', clientKey: 'website-key', fetchImpl: async (url, init) => {
    payload = JSON.parse(init.body); return { ok: true, status: 201 };
  } };
  const res = await createHandler(db, { forward })(post('/api/support', supportBody({
    contact_preference: 'anonymous', email: 'accidental@example.com', name: 'Do not retain',
    reason: 'issue', subject: '', diagnostics_reference: 'local-report-123',
  })));
  assert.equal(res.status, 200);
  assert.equal(db.supportRows[0].email, '');
  assert.equal(db.supportRows[0].name, '');
  assert.equal(db.supportRows[0].contact_preference, 'anonymous');
  assert.equal(db.supportRows[0].reason, 'issue');
  assert.equal(db.supportRows[0].subject, `Problem report [${db.supportRows[0].case_number}]`);
  assert.equal(db.supportRows[0].diagnostics_reference, 'local-report-123');
  assert.equal(payload.contactPreference, 'anonymous');
  assert.equal(payload.reason, 'issue');
  assert.ok(!('email' in payload));
  assert.ok(!('name' in payload));
  assert.match(payload.message, /local-report-123/);
  assert.doesNotMatch(JSON.stringify(payload), /accidental|Do not retain/);
});

test('minimal anonymous submission needs only a message', async () => {
  const db = fakeDb();
  const res = await createHandler(db)(post('/api/support', { message: 'An idea for you.' }));
  assert.equal(res.status, 200);
  assert.equal(db.supportRows[0].reason, 'feedback');
  assert.equal(db.supportRows[0].contact_preference, 'anonymous');
});

test('response requires email, not name', async () => {
  for (const choice of ['reply']) {
    const db = fakeDb();
    const handle = createHandler(db);
    const invalid = await handle(post('/api/support', supportBody({ contact_preference: choice, email: '' })));
    assert.equal(invalid.status, 400);
    const valid = await handle(formPost('/api/support', supportBody({ contact_preference: choice, name: '' })));
    assert.equal(valid.status, 303);
    assert.equal(db.supportRows[0].contact_preference, choice);
    assert.equal(db.supportRows[0].email, 'ada@example.com');
    assert.equal(db.supportRows[0].name, '');
  }
});

test('support rejects invalid preferences, reasons and diagnostic references', async () => {
  const handle = createHandler(fakeDb());
  for (const overrides of [
    { reason: 'other-unknown' }, { reason: '__proto__' }, { contact_preference: 'subscribe' }, { contact_preference: 'fix-update' },
    { diagnostics_reference: 'x'.repeat(501) }, { diagnostics_reference: 'one\ntwo' },
    { contact_preference: 'reply', email: 'bad' },
  ]) {
    const res = await handle(post('/api/support', supportBody(overrides)));
    assert.equal(res.status, 400);
  }
});

test('multipart anonymous submission strips accidental identity too', async () => {
  const db = fakeDb();
  const form = new FormData();
  for (const [key, value] of Object.entries(supportBody({ contact_preference: 'anonymous', reason: 'product' }))) {
    form.set(key, value);
  }
  const request = new Request('https://api.blowhorn.ai/api/support', { method: 'POST', body: form });
  const res = await createHandler(db)(request);
  assert.equal(res.status, 303);
  assert.equal(db.supportRows[0].email, '');
  assert.equal(db.supportRows[0].reason, 'product');
});

test('support reason is a string, not a coerced array', async () => {
  const res = await createHandler(fakeDb())(post('/api/support', supportBody({ reason: ['issue'] })));
  assert.equal(res.status, 400);
});

test('support migration preserves existing rows and adapter stores anonymous metadata', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const here = dirname(fileURLToPath(import.meta.url));
  sqlite.exec(readFileSync(join(here, 'migrations/0003_support_messages.sql'), 'utf8'));
  sqlite.prepare('INSERT INTO support_messages (name,email,subject,message,created_at) VALUES (?,?,?,?,?)')
    .run('Original', 'old@example.com', 'Old', 'Old message', '2026-11-20');
  sqlite.exec(readFileSync(join(here, 'migrations/0004_support_preferences.sql'), 'utf8'));
  const old = sqlite.prepare('SELECT * FROM support_messages WHERE id=1').get();
  assert.equal(old.email, 'old@example.com');
  assert.equal(old.contact_preference, 'reply');
  assert.equal(old.reason, 'feedback');
  sqlite.exec(readFileSync(join(here, 'migrations/0005_support_case_proof.sql'), 'utf8'));
  assert.equal(sqlite.prepare('SELECT creation_proof FROM support_messages WHERE id=1').get().creation_proof, null);
  const adapter = d1Db({ prepare(sql) { return { bind(...params) { return {
    run() { const result = sqlite.prepare(sql).run(...params); return { meta: { last_row_id: Number(result.lastInsertRowid) } }; },
  }; } }; } });
  const id = await adapter.insertSupportMessage({ name: '', email: '', subject: 'Feedback', message: 'Hello',
    details: '', created_at: '2026-11-23', source_page: '/support/', reason: 'feedback',
    contact_preference: 'anonymous', diagnostics_reference: 'local-123', case_number: crypto.randomUUID(),
    creation_proof: 'a'.repeat(64) });
  await adapter.markSupportForwarded(id);
  const row = sqlite.prepare('SELECT * FROM support_messages WHERE id=?').get(id);
  assert.equal(row.name, '');
  assert.equal(row.email, '');
  assert.equal(row.contact_preference, 'anonymous');
  assert.equal(row.diagnostics_reference, 'local-123');
  assert.equal(row.creation_proof, 'a'.repeat(64));
  assert.ok(row.forwarded_at);
  sqlite.close();
});

test('case numbers are server generated, unique, and subjects ignore client overrides', async () => {
  const db = fakeDb();
  const calls = [];
  const forward = { url: 'https://cloud.example.test/api/support/cases', clientKey: 'website-key', fetchImpl: async (url, init) => {
    calls.push(JSON.parse(init.body)); return { ok: true, status: 201 };
  } };
  const handle = createHandler(db, { forward });
  for (const reason of ['feedback', 'issue', 'product', 'pricing', 'connect']) {
    const res = await handle(post('/api/support', supportBody({ reason,
      subject: 'User-supplied subject must not be used'.repeat(20), case_number: 'attacker-selected-id',
    })));
    assert.equal(res.status, 200);
  }
  const ids = db.supportRows.map(row => row.case_number);
  assert.equal(new Set(ids).size, 5);
  for (const [i, row] of db.supportRows.entries()) {
    assert.match(row.case_number, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(row.subject.includes(row.case_number));
    assert.equal(calls[i].caseId, row.case_number);
    assert.equal(calls[i].reason, row.reason);
    assert.doesNotMatch(JSON.stringify(calls[i]), /User-supplied|attacker-selected/);
  }
});

test('the deployed entry point forwards a support message with the runtime fetch', async () => {
  // Workers throws "Illegal invocation" when fetch is called with any `this`
  // other than the global scope, e.g. as `forward.fetchImpl(...)`. Node does
  // not, so the stub enforces the runtime's rule.
  const sqlite = new DatabaseSync(':memory:');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const m of ['0001_init.sql', '0002_rate_limits_window_idx.sql', '0003_support_messages.sql',
    '0004_support_preferences.sql', '0005_support_case_proof.sql']) {
    sqlite.exec(readFileSync(join(here, 'migrations', m), 'utf8'));
  }
  const SIGNUPS_DB = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return {
    first() { return stmt.get(...params) || null; },
    all() { return { results: stmt.all(...params) }; },
    run() { const r = stmt.run(...params); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid) } }; },
  }; } }; } };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetch(url, init) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    }
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Promise.resolve(new Response('{}', { status: 201 }));
  };
  try {
    const env = { SIGNUPS_DB, SUPPORT_CASES_URL: 'https://cloud.example.test/api/support/cases', SUPPORT_CASES_CLIENT_KEY: 'website-key' };
    const res = await worker.fetch(post('/api/support', supportBody()), env);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cloud.example.test/api/support/cases');
  assert.equal(calls[0].headers['x-client-key'], 'website-key');
  const row = sqlite.prepare('SELECT case_number, forwarded_at FROM support_messages').get();
  assert.equal(calls[0].body.caseId, row.case_number);
  assert.ok(row.forwarded_at, 'a 201 from Cloud marks the row forwarded');
  sqlite.close();
});

// Scheduled retry of unforwarded support cases, over a real SQLite D1 with
// every migration applied.

const ALL_MIGRATIONS = ['0001_init.sql', '0002_rate_limits_window_idx.sql', '0003_support_messages.sql',
  '0004_support_preferences.sql', '0005_support_case_proof.sql', '0006_support_forward_retry.sql'];

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const m of ALL_MIGRATIONS) sqlite.exec(readFileSync(join(here, 'migrations', m), 'utf8'));
  const binding = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...params) { return {
    first() { return stmt.get(...params) || null; },
    all() { return { results: stmt.all(...params) }; },
    run() { const r = stmt.run(...params); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid) } }; },
  }; } }; } };
  return { sqlite, binding, db: d1Db(binding) };
}

function insertRow(sqlite, overrides = {}) {
  const row = {
    name: 'Ada Lovelace', email: 'ada@example.com', subject: 'Feedback [x]', message: 'Hello',
    details: '', created_at: '2026-11-24T00:00:00.000Z', source_page: '/support/', reason: 'feedback',
    contact_preference: 'reply', diagnostics_reference: '', case_number: crypto.randomUUID(),
    creation_proof: 'b'.repeat(64), forwarded_at: null, forward_attempts: 0, forward_last_status: null,
    next_forward_at: null, ...overrides,
  };
  const cols = Object.keys(row);
  const r = sqlite.prepare(`INSERT INTO support_messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
  return Number(r.lastInsertRowid);
}

function getRow(sqlite, id) {
  return { ...sqlite.prepare('SELECT * FROM support_messages WHERE id = ?').get(id) };
}

function recordingForward(statusFor = () => 201) {
  const calls = [];
  return {
    calls,
    url: 'https://cloud.example.test/api/support/cases',
    clientKey: 'website-key',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, rawBody: init.body, body });
      const status = statusFor(body, calls.length);
      if (status instanceof Error) throw status;
      return { ok: status >= 200 && status < 300, status };
    },
  };
}

const NOW = Date.parse('2026-11-25T03:00:00.000Z');

test('a failed request-path forward is replayed by the cron with the identical case, proof and payload', async () => {
  const { sqlite, binding } = sqliteD1();
  const failing = recordingForward(() => 503);
  const res = await createHandler(d1Db(binding), { forward: failing })(post('/api/support', supportBody({
    reason: 'issue', diagnostics_reference: 'local-ref-1',
  })));
  assert.equal(res.status, 200);
  const sent = failing.calls[0];
  const stored = sqlite.prepare('SELECT * FROM support_messages').get();
  assert.equal(stored.forwarded_at, null);
  assert.equal(stored.forward_attempts, 1, 'the request-path failure counts as the first attempt');
  assert.equal(stored.forward_last_status, 503);
  assert.ok(stored.next_forward_at);

  const replay = recordingForward(() => 200);
  const later = Date.parse(stored.next_forward_at) + 1;
  await createScheduledHandler(d1Db(binding), () => later, { forward: replay })({ scheduledTime: later });
  assert.equal(replay.calls.length, 1);
  assert.equal(replay.calls[0].rawBody, sent.rawBody, 'the replay body is byte-identical');
  assert.equal(replay.calls[0].headers['x-support-creation-proof'], stored.creation_proof);
  assert.equal(replay.calls[0].headers['x-support-creation-proof'], sent.headers['x-support-creation-proof']);
  assert.equal(replay.calls[0].body.caseId, stored.case_number);
  const after = sqlite.prepare('SELECT * FROM support_messages').get();
  assert.equal(after.case_number, stored.case_number, 'no new case id is minted');
  assert.equal(after.creation_proof, stored.creation_proof);
  assert.equal(after.forwarded_at, new Date(later).toISOString());
  sqlite.close();
});

test('pre-contract rows without a case number or proof are never sent or modified', async () => {
  const { sqlite, db } = sqliteD1();
  const noCase = insertRow(sqlite, { case_number: null, creation_proof: null, email: 'e2e-test@example.com' });
  const noProof = insertRow(sqlite, { creation_proof: null });
  const before = [getRow(sqlite, noCase), getRow(sqlite, noProof)];
  const forward = recordingForward();
  const summary = await retryUnforwardedSupport(db, forward, NOW);
  assert.deepEqual(summary, { selected: 0, forwarded: 0, failed: 0 });
  assert.equal(forward.calls.length, 0);
  assert.deepEqual([getRow(sqlite, noCase), getRow(sqlite, noProof)], before);
  sqlite.close();
});

test('forwarded rows are never re-sent and keep their forwarded_at', async () => {
  const { sqlite, db } = sqliteD1();
  const id = insertRow(sqlite, { forwarded_at: '2026-11-24T22:33:04.916Z' });
  const before = getRow(sqlite, id);
  const forward = recordingForward();
  await retryUnforwardedSupport(db, forward, NOW);
  assert.equal(forward.calls.length, 0);
  assert.deepEqual(getRow(sqlite, id), before);
  sqlite.close();
});

test('forwarded_at is set only on 201 or 200; failures back off and count attempts', async () => {
  const { sqlite, db } = sqliteD1();
  const created = insertRow(sqlite);
  const replayed = insertRow(sqlite);
  const serverError = insertRow(sqlite);
  const thrown = insertRow(sqlite);
  const statuses = { 1: 201, 2: 200, 3: 500 };
  const forward = recordingForward((body, n) => statuses[n] ?? new TypeError('network down'));
  const summary = await retryUnforwardedSupport(db, forward, NOW);
  assert.deepEqual(summary, { selected: 4, forwarded: 2, failed: 2 });
  assert.equal(getRow(sqlite, created).forwarded_at, new Date(NOW).toISOString());
  assert.equal(getRow(sqlite, replayed).forwarded_at, new Date(NOW).toISOString());
  const err = getRow(sqlite, serverError);
  assert.equal(err.forwarded_at, null);
  assert.equal(err.forward_attempts, 1);
  assert.equal(err.forward_last_status, 500);
  assert.equal(err.next_forward_at, new Date(NOW + SUPPORT_RETRY_BASE_MS).toISOString());
  const threw = getRow(sqlite, thrown);
  assert.equal(threw.forwarded_at, null);
  assert.equal(threw.forward_attempts, 1);
  assert.equal(threw.forward_last_status, 0, 'a thrown fetch records status 0');
  sqlite.close();
});

test('a row is not retried before its backoff elapses, then is retried once due', async () => {
  const { sqlite, db } = sqliteD1();
  const id = insertRow(sqlite, { forward_attempts: 3, forward_last_status: 503,
    next_forward_at: new Date(NOW + 60000).toISOString() });
  const early = recordingForward();
  await retryUnforwardedSupport(db, early, NOW);
  assert.equal(early.calls.length, 0);
  const due = recordingForward(() => 502);
  await retryUnforwardedSupport(db, due, NOW + 60000);
  assert.equal(due.calls.length, 1);
  const row = getRow(sqlite, id);
  assert.equal(row.forward_attempts, 4);
  assert.equal(row.next_forward_at, new Date(NOW + 60000 + supportRetryDelayMs(4)).toISOString());
  sqlite.close();
});

test('backoff doubles from the base and caps at the maximum delay', () => {
  assert.equal(supportRetryDelayMs(1), SUPPORT_RETRY_BASE_MS);
  assert.equal(supportRetryDelayMs(2), 2 * SUPPORT_RETRY_BASE_MS);
  assert.equal(supportRetryDelayMs(3), 4 * SUPPORT_RETRY_BASE_MS);
  assert.equal(supportRetryDelayMs(30), SUPPORT_RETRY_MAX_DELAY_MS);
});

test('rows at the attempt cap, 409 conflicts and rows still in their first minutes are skipped', async () => {
  const { sqlite, db } = sqliteD1();
  const capped = insertRow(sqlite, { forward_attempts: SUPPORT_RETRY_MAX_ATTEMPTS, forward_last_status: 503 });
  const conflict = insertRow(sqlite, { forward_attempts: 1, forward_last_status: 409 });
  const fresh = insertRow(sqlite, { created_at: new Date(NOW - 30000).toISOString() });
  const before = [capped, conflict, fresh].map((id) => getRow(sqlite, id));
  const forward = recordingForward();
  await retryUnforwardedSupport(db, forward, NOW);
  assert.equal(forward.calls.length, 0);
  assert.deepEqual([capped, conflict, fresh].map((id) => getRow(sqlite, id)), before);
  sqlite.close();
});

test('a 409 on retry stops further retries for that case', async () => {
  const { sqlite, db } = sqliteD1();
  const id = insertRow(sqlite);
  await retryUnforwardedSupport(db, recordingForward(() => 409), NOW);
  assert.equal(getRow(sqlite, id).forward_last_status, 409);
  const again = recordingForward();
  await retryUnforwardedSupport(db, again, NOW + SUPPORT_RETRY_MAX_DELAY_MS);
  assert.equal(again.calls.length, 0);
  assert.equal(getRow(sqlite, id).forwarded_at, null);
  sqlite.close();
});

test('each run sends at most the batch cap, oldest first', async () => {
  const { sqlite, db } = sqliteD1();
  const ids = Array.from({ length: SUPPORT_RETRY_BATCH + 3 }, () => insertRow(sqlite));
  const forward = recordingForward();
  const summary = await retryUnforwardedSupport(db, forward, NOW);
  assert.equal(summary.selected, SUPPORT_RETRY_BATCH);
  assert.equal(forward.calls.length, SUPPORT_RETRY_BATCH);
  const caseIds = ids.map((id) => getRow(sqlite, id).case_number);
  assert.deepEqual(forward.calls.map((c) => c.body.caseId), caseIds.slice(0, SUPPORT_RETRY_BATCH));
  const second = recordingForward();
  await retryUnforwardedSupport(db, second, NOW + 1);
  assert.deepEqual(second.calls.map((c) => c.body.caseId), caseIds.slice(SUPPORT_RETRY_BATCH));
  sqlite.close();
});

test('the retry only calls the configured cases URL and anonymous rows send no identity', async () => {
  const { sqlite, db } = sqliteD1();
  insertRow(sqlite, { name: '', email: '', contact_preference: 'anonymous' });
  const forward = recordingForward();
  await retryUnforwardedSupport(db, forward, NOW);
  assert.equal(forward.calls.length, 1);
  assert.equal(forward.calls[0].url, 'https://cloud.example.test/api/support/cases');
  assert.deepEqual(Object.keys(forward.calls[0].body).sort(), ['caseId', 'contactPreference', 'message', 'reason']);
  sqlite.close();
});

test('without a configured forward the cron only prunes', async () => {
  const { sqlite, db } = sqliteD1();
  const id = insertRow(sqlite);
  const before = getRow(sqlite, id);
  await createScheduledHandler(db, () => NOW)({ scheduledTime: NOW });
  assert.deepEqual(getRow(sqlite, id), before);
  sqlite.close();
});

test('a prune failure still lets the retry run and is still reported', async () => {
  const { sqlite, db } = sqliteD1();
  const id = insertRow(sqlite);
  db.pruneRateLimits = async () => { throw new Error('D1 transient failure'); };
  const forward = recordingForward();
  await assert.rejects(createScheduledHandler(db, () => NOW, { forward })({ scheduledTime: NOW }), /D1 transient failure/);
  assert.equal(forward.calls.length, 1);
  assert.ok(getRow(sqlite, id).forwarded_at);
  sqlite.close();
});

test('the deployed scheduled entry point retries with the runtime fetch', async () => {
  const { sqlite, binding } = sqliteD1();
  const id = insertRow(sqlite);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetch(url, init) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    }
    calls.push({ url, headers: init.headers });
    return Promise.resolve(new Response('{}', { status: 201 }));
  };
  try {
    const env = { SIGNUPS_DB: binding, SUPPORT_CASES_URL: 'https://cloud.example.test/api/support/cases', SUPPORT_CASES_CLIENT_KEY: 'website-key' };
    await worker.scheduled({ scheduledTime: NOW }, env);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-client-key'], 'website-key');
  assert.equal(getRow(sqlite, id).forwarded_at, new Date(NOW).toISOString());
  sqlite.close();
});
