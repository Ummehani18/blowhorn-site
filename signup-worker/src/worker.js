// Blowhorn signup service: coming-soon waitlists, the Blowhorn newsletter and
// the support page's contact form (/api/support).
//
// Served at https://api.blowhorn.ai (custom domain). A blowhorn.ai/api/*
// route was dropped: the apex is DNS-only, so such a route can never
// serve traffic.
// No confirmation step: a signup is live as soon as it is stored. Every
// ship email and newsletter email carries an unsubscribe link built from
// the row token.
//
// Storage: Cloudflare D1 tables signups and support_messages (see
// migrations/). The db object is a small adapter over the D1 binding (d1Db)
// so tests can inject an in-memory fake with the same methods.

export const SITE_ORIGIN = 'https://blowhorn.ai';
export const THANKS_URL = `${SITE_ORIGIN}/coming-soon/thanks/`;
export const SUPPORT_THANKS_URL = `${SITE_ORIGIN}/support/thanks/`;

const RATE_LIMIT_PER_MINUTE = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOPIC_RE = /^[a-z0-9-]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const MAX_EMAIL = 254;
const MAX_REMARK = 500;
const MAX_SOURCE_PAGE = 500;
const MAX_NAME = 100;
// Subjects are generated from a bounded reason label and UUID case number.
const MAX_MESSAGE = 5000;
const MAX_DETAILS = 5000;
const MAX_DIAGNOSTICS_REFERENCE = 500;
const SUPPORT_REASONS = {
  feedback: 'Feedback', issue: 'Problem report', product: 'Product question',
  pricing: 'Pricing or licensing', connect: 'Get in touch',
};
const CONTACT_PREFERENCES = ['anonymous', 'reply'];
export const MAX_BODY_BYTES = 10 * 1024;

// Per-case creation proof: 256 bits as 64 lowercase hex, sent to Cloud as
// X-Support-Creation-Proof and stored on the row so a replay stays
// idempotent. Never returned to the browser.
function randomCreationProof() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function d1Db(db) {
  return {
    async getSignup(email, kind, topic) {
      return db
        .prepare('SELECT * FROM signups WHERE email = ?1 AND kind = ?2 AND topic IS ?3')
        .bind(email, kind, topic)
        .first();
    },
    async insertSignup(row) {
      await db
        .prepare(
          'INSERT INTO signups (email, kind, topic, remark, token, created_at, source_page) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        )
        .bind(row.email, row.kind, row.topic, row.remark, row.token, row.created_at, row.source_page)
        .run();
    },
    async updateSignup(row) {
      await db
        .prepare(
          'UPDATE signups SET remark = ?1, source_page = ?2, unsubscribed_at = NULL WHERE email = ?3 AND kind = ?4 AND topic IS ?5',
        )
        .bind(row.remark, row.source_page, row.email, row.kind, row.topic)
        .run();
    },
    async rateHit(ip, window) {
      const res = await db
        .prepare(
          'INSERT INTO rate_limits (ip, window, count) VALUES (?1, ?2, 1) ON CONFLICT (ip, window) DO UPDATE SET count = count + 1 RETURNING count',
        )
        .bind(ip, window)
        .all();
      return res.results && res.results[0] ? res.results[0].count : 1;
    },
    async pruneRateLimits(cutoff) {
      await db.prepare('DELETE FROM rate_limits WHERE window < ?1').bind(cutoff).run();
    },
    async getByToken(token) {
      return db.prepare('SELECT * FROM signups WHERE token = ?1').bind(token).first();
    },
    async markUnsubscribed(token) {
      await db
        .prepare('UPDATE signups SET unsubscribed_at = ?1 WHERE token = ?2')
        .bind(new Date().toISOString(), token)
        .run();
    },
    async insertSupportMessage(row) {
      const res = await db
        .prepare(
          'INSERT INTO support_messages (name, email, subject, message, details, created_at, source_page, reason, contact_preference, diagnostics_reference, case_number, creation_proof) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)',
        )
        .bind(row.name, row.email, row.subject, row.message, row.details, row.created_at, row.source_page, row.reason, row.contact_preference, row.diagnostics_reference, row.case_number, row.creation_proof)
        .run();
      return res.meta && typeof res.meta.last_row_id === 'number' ? res.meta.last_row_id : null;
    },
    async markSupportForwarded(id, at = new Date().toISOString()) {
      await db
        .prepare('UPDATE support_messages SET forwarded_at = ?1 WHERE id = ?2 AND forwarded_at IS NULL')
        .bind(at, id)
        .run();
    },
    async recordSupportForwardFailure(id, status, nextAt) {
      await db
        .prepare(
          'UPDATE support_messages SET forward_attempts = forward_attempts + 1, forward_last_status = ?1, next_forward_at = ?2 WHERE id = ?3 AND forwarded_at IS NULL',
        )
        .bind(status, nextAt, id)
        .run();
    },
    async listSupportRetries({ now, createdBefore, maxAttempts, limit }) {
      const res = await db
        .prepare(
          'SELECT id, name, email, message, details, reason, contact_preference, diagnostics_reference, case_number, creation_proof, forward_attempts FROM support_messages'
            + ' WHERE forwarded_at IS NULL AND case_number IS NOT NULL AND creation_proof IS NOT NULL'
            + ' AND forward_attempts < ?1 AND (forward_last_status IS NULL OR forward_last_status <> 409)'
            + ' AND (next_forward_at IS NULL OR next_forward_at <= ?2) AND created_at <= ?3'
            + ' ORDER BY id LIMIT ?4',
        )
        .bind(maxAttempts, now, createdBefore, limit)
        .all();
      return res.results || [];
    },
  };
}

function clientIp(request) {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct) return direct.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (origin === SITE_ORIGIN) return { 'access-control-allow-origin': SITE_ORIGIN, vary: 'Origin' };
  return {};
}

function jsonResponse(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders(request),
    },
  });
}

export function safeHtml(content) {
  return { html: String(content ?? '') };
}

export function pageResponse(request, status, title, body) {
  const safeTitle = escHtml(title);
  const safeBody = (typeof body === 'object' && body !== null && 'html' in body)
    ? body.html
    : escHtml(body);
  return new Response(
    `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${safeTitle}</title></head>\n<body>\n<main>\n<h1>${safeTitle}</h1>\n<p>${safeBody}</p>\n</main>\n</body>\n</html>\n`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
        ...corsHeaders(request),
      },
    },
  );
}

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeBackLink(sourcePage) {
  if (
    typeof sourcePage === 'string'
    && sourcePage.startsWith('/')
    && !sourcePage.startsWith('//')
    && !sourcePage.startsWith('/\\')
    && !/[\s"'<>\\]/.test(sourcePage)
  ) {
    return `${SITE_ORIGIN}${sourcePage}`;
  }
  return SITE_ORIGIN;
}

async function readFields(request) {
  const clHeader = request.headers.get('content-length');
  if (clHeader !== null) {
    const cl = parseInt(clHeader, 10);
    if (!isNaN(cl) && cl > MAX_BODY_BYTES) {
      return { tooLarge: true };
    }
  }

  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const text = await request.text().catch(() => null);
    if (text === null) return null;
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return { tooLarge: true };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return {
      email: body.email,
      topic: body.topic,
      remark: body.remark,
      website: body.website,
      source_page: body.source_page,
      token: body.token,
      name: body.name,
      message: body.message,
      details: body.details,
      reason: body.reason,
      contact_preference: body.contact_preference,
      diagnostics_reference: body.diagnostics_reference,
    };
  }

  if (type.includes('application/x-www-form-urlencoded')) {
    const text = await request.text().catch(() => null);
    if (text === null) return null;
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return { tooLarge: true };
    }
    const params = new URLSearchParams(text);
    return {
      email: params.get('email'),
      topic: params.get('topic'),
      remark: params.get('remark'),
      website: params.get('website'),
      source_page: params.get('source_page'),
      token: params.get('token'),
      name: params.get('name'),
      message: params.get('message'),
      details: params.get('details'),
      reason: params.get('reason') ?? undefined,
      contact_preference: params.get('contact_preference') ?? undefined,
      diagnostics_reference: params.get('diagnostics_reference'),
    };
  }

  if (type.includes('multipart/form-data')) {
    const text = await request.text().catch(() => null);
    if (text === null) return null;
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return { tooLarge: true };
    }
    const tempReq = new Request('https://blowhorn.ai', {
      method: 'POST',
      headers: request.headers,
      body: text,
    });
    const form = await tempReq.formData().catch(() => null);
    if (!form) return null;
    return {
      email: form.get('email'),
      topic: form.get('topic'),
      remark: form.get('remark'),
      website: form.get('website'),
      source_page: form.get('source_page'),
      token: form.get('token'),
      name: form.get('name'),
      message: form.get('message'),
      details: form.get('details'),
      reason: form.get('reason') ?? undefined,
      contact_preference: form.get('contact_preference') ?? undefined,
      diagnostics_reference: form.get('diagnostics_reference'),
    };
  }

  return null;
}

function isFormPost(request) {
  return (request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')
    || (request.headers.get('content-type') || '').includes('multipart/form-data');
}

function fail(request, status, message, sourcePage) {
  if (isFormPost(request)) {
    const link = escHtml(safeBackLink(sourcePage));
    const safeMsg = escHtml(message);
    const title = status === 413 ? 'Payload too large' : 'Something went wrong';
    return pageResponse(
      request,
      status,
      title,
      safeHtml(`${safeMsg} <a href="${link}">Go back</a> and try again.`),
    );
  }
  return jsonResponse(request, status, { ok: false, error: message });
}

function validateSignup(kind, fields) {
  const email = typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  let topic = null;
  if (kind === 'waitlist') {
    topic = typeof fields.topic === 'string' ? fields.topic.trim().toLowerCase() : '';
    if (!TOPIC_RE.test(topic)) return { error: 'Unknown waitlist topic.' };
  }
  const remark = typeof fields.remark === 'string' ? fields.remark.trim() : '';
  if (remark.length > MAX_REMARK) return { error: 'The remark is too long (500 characters max).' };
  const sourcePage = typeof fields.source_page === 'string' ? fields.source_page.trim().slice(0, MAX_SOURCE_PAGE) : '';
  return { email, topic, remark, sourcePage };
}

function validateSupport(fields) {
  const reason = fields.reason === undefined ? 'feedback' : fields.reason;
  if (typeof reason !== 'string' || !Object.hasOwn(SUPPORT_REASONS, reason)) return { error: 'Choose a reason for reaching out.' };
  // Legacy clients supplied email without a preference. New empty submissions
  // default to anonymous; an explicit anonymous choice always drops identity.
  const contactPreference = fields.contact_preference === undefined
    ? (fields.email ? 'reply' : 'anonymous') : fields.contact_preference;
  if (!CONTACT_PREFERENCES.includes(contactPreference)) return { error: 'Choose a response preference.' };
  const anonymous = contactPreference === 'anonymous';
  const name = !anonymous && typeof fields.name === 'string' ? fields.name.trim() : '';
  if (name.length > MAX_NAME) return { error: 'The name is too long (100 characters max).' };
  const email = !anonymous && typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '';
  if (!anonymous && (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email))) return { error: 'Enter an email address for a response, or choose anonymous.' };
  const caseNumber = crypto.randomUUID();
  const subject = `${SUPPORT_REASONS[reason]} [${caseNumber}]`;
  const message = typeof fields.message === 'string' ? fields.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE) return { error: 'Enter a message (5,000 characters max).' };
  const details = typeof fields.details === 'string' ? fields.details.trim() : '';
  if (details.length > MAX_DETAILS) return { error: 'The details are too long (5,000 characters max).' };
  const sourcePage = typeof fields.source_page === 'string' ? fields.source_page.trim().slice(0, MAX_SOURCE_PAGE) : '';
  const diagnosticsReference = typeof fields.diagnostics_reference === 'string' ? fields.diagnostics_reference.trim() : '';
  if (diagnosticsReference.length > MAX_DIAGNOSTICS_REFERENCE || /[\r\n\x00-\x1f\x7f]/.test(diagnosticsReference)) return { error: 'Enter a single-line diagnostic reference (500 characters max).' };
  return { name, email, subject, caseNumber, message, details, sourcePage, reason, contactPreference, diagnosticsReference };
}

// Every support submission becomes a durable Cloud support case
// (POST /api/support/cases; the contract lives in meshery-cloud's
// docs/reference/support-cases.md). The row's case number is the caseId and
// the per-case creation proof authenticates an idempotent replay, so
// retrying an unchanged row returns 200 and never duplicates the case or
// its private GitHub issue. The forward stays best-effort: the D1 row is
// the local record, and a failed create leaves forwarded_at NULL so the
// scheduled retry can re-send it. Anonymous rows carry no email or name.
//
// The payload is built only from fields stored on the row, so the request
// path and the scheduled retry send byte-identical bodies for the same case.
export function supportCaseBody(row) {
  const body = {
    caseId: row.case_number,
    reason: row.reason,
    contactPreference: row.contact_preference,
    message: [
      row.message,
      row.details ? `Diagnostic summary:\n${row.details}` : '',
      row.diagnostics_reference ? `Diagnostic reference (unverified, not fetched): ${row.diagnostics_reference}` : '',
    ].filter(Boolean).join('\n\n'),
  };
  if (row.email) body.email = row.email;
  if (row.name) body.name = row.name;
  return body;
}

// Returns { attempted, ok, status }. status is the HTTP status, or 0 when
// the call threw (network error, timeout).
async function forwardSupport(forward, row) {
  if (!forward || !forward.url || !forward.clientKey) return { attempted: false, ok: false, status: 0 };
  try {
    const res = await forward.fetchImpl(forward.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-client-key': forward.clientKey,
        'x-support-creation-proof': row.creation_proof,
      },
      body: JSON.stringify(supportCaseBody(row)),
      signal: AbortSignal.timeout(10000),
    });
    // 201 created the case; 200 is the identical-payload replay. Both mean
    // the case durably exists. A 409 (same caseId, different payload) or
    // any other status leaves the row unforwarded.
    return { attempted: true, ok: res.status === 201 || res.status === 200, status: res.status };
  } catch {
    return { attempted: true, ok: false, status: 0 };
  }
}

// Scheduled retry of unforwarded support cases. Each cron run re-sends at
// most SUPPORT_RETRY_BATCH rows, oldest first. After a failed attempt n the
// next try waits SUPPORT_RETRY_BASE_MS * 2^(n-1), capped at
// SUPPORT_RETRY_MAX_DELAY_MS; after SUPPORT_RETRY_MAX_ATTEMPTS failures the
// row is left for investigation. A 409 means Cloud holds a different payload
// under this caseId, which retrying cannot fix, so it is never retried. Rows
// younger than SUPPORT_RETRY_MIN_AGE_MS are skipped so the cron never races
// the request that is still forwarding them. Rows without a case number or
// creation proof predate the Cloud contract and are never touched.
export const SUPPORT_RETRY_BATCH = 5;
export const SUPPORT_RETRY_MAX_ATTEMPTS = 10;
export const SUPPORT_RETRY_BASE_MS = 15 * 60 * 1000;
export const SUPPORT_RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
export const SUPPORT_RETRY_MIN_AGE_MS = 2 * 60 * 1000;

export function supportRetryDelayMs(attempts) {
  const n = Math.max(1, attempts);
  return Math.min(SUPPORT_RETRY_BASE_MS * 2 ** (n - 1), SUPPORT_RETRY_MAX_DELAY_MS);
}

async function recordFailure(db, row, status, nowMs) {
  const attempts = (row.forward_attempts || 0) + 1;
  await db.recordSupportForwardFailure(row.id, status, new Date(nowMs + supportRetryDelayMs(attempts)).toISOString());
}

export async function retryUnforwardedSupport(db, forward, nowMs) {
  const summary = { selected: 0, forwarded: 0, failed: 0 };
  if (!forward || !forward.url || !forward.clientKey) return summary;
  const rows = await db.listSupportRetries({
    now: new Date(nowMs).toISOString(),
    createdBefore: new Date(nowMs - SUPPORT_RETRY_MIN_AGE_MS).toISOString(),
    maxAttempts: SUPPORT_RETRY_MAX_ATTEMPTS,
    limit: SUPPORT_RETRY_BATCH,
  });
  summary.selected = rows.length;
  for (const row of rows) {
    try {
      const result = await forwardSupport(forward, row);
      if (result.ok) {
        await db.markSupportForwarded(row.id, new Date(nowMs).toISOString());
        summary.forwarded += 1;
      } else {
        await recordFailure(db, row, result.status, nowMs);
        summary.failed += 1;
      }
    } catch {
      // A D1 write failed; the next run picks the row up again.
      summary.failed += 1;
    }
  }
  return summary;
}

// SUPPORT_CASES_URL in wrangler.json [vars] is the Cloud support-cases
// route. SUPPORT_CASES_CLIENT_KEY is a wrangler secret: the website client
// key provisioned in Cloud. Either missing stores to D1 only.
function supportForwardFromEnv(env) {
  const url = env && typeof env.SUPPORT_CASES_URL === 'string' ? env.SUPPORT_CASES_URL.trim() : '';
  const clientKey = env && typeof env.SUPPORT_CASES_CLIENT_KEY === 'string' ? env.SUPPORT_CASES_CLIENT_KEY.trim() : '';
  if (!url || !clientKey) return null;
  // Wrapped, not `fetch` itself: Workers throws "Illegal invocation" when
  // fetch runs with a `this` other than the global scope, and forwardSupport
  // calls it as forward.fetchImpl(...). The throw was caught as a failed
  // forward, so no submission ever reached Cloud.
  return { url, clientKey, fetchImpl: (input, init) => fetch(input, init) };
}

export function createHandler(db, options = {}) {
  const forward = options.forward || null;
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': SITE_ORIGIN,
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': 'Content-Type',
          vary: 'Origin',
          ...SECURITY_HEADERS,
        },
      });
    }
    const isWaitlist = request.method === 'POST' && url.pathname === '/api/waitlist';
    const isSubscribe = request.method === 'POST' && url.pathname === '/api/subscribe';
    const isSupport = request.method === 'POST' && url.pathname === '/api/support';
    const isUnsubscribeGet = request.method === 'GET' && url.pathname === '/api/unsubscribe';
    const isUnsubscribePost = request.method === 'POST' && url.pathname === '/api/unsubscribe';
    if (!isWaitlist && !isSubscribe && !isSupport && !isUnsubscribeGet && !isUnsubscribePost) {
      return new Response('Not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
      });
    }

    // Per-IP rate limit, Tells shape (30 req/min), backed by D1.
    try {
      const window = Math.floor(Date.now() / 60000);
      const count = await db.rateHit(clientIp(request), window);
      if (count > RATE_LIMIT_PER_MINUTE) {
        if (isUnsubscribeGet || isUnsubscribePost) {
          return pageResponse(request, 429, 'Too many requests', 'Too many requests. Try again shortly.');
        }
        return fail(request, 429, 'Too many requests. Try again shortly.', null);
      }
    } catch {
      if (isUnsubscribeGet) {
        return pageResponse(request, 500, 'Something went wrong', 'Something went wrong. Try again shortly.');
      }
      return fail(request, 500, 'Something went wrong.', null);
    }

    if (isUnsubscribeGet) {
      const token = url.searchParams.get('token') || '';
      if (!token || !TOKEN_RE.test(token)) {
        return pageResponse(
          request,
          400,
          'Unsubscribe link incomplete',
          'This unsubscribe link is missing its key. Use the link from the email you got.',
        );
      }
      try {
        const row = await db.getByToken(token);
        if (!row) {
          return pageResponse(
            request,
            404,
            'Unsubscribe link not recognized',
            'No subscription matches this link. It may be from an older email, or the link may be incomplete.',
          );
        }
        if (row.unsubscribed_at) {
          return pageResponse(
            request,
            200,
            'Unsubscribed',
            'You are unsubscribed. You will get no more emails from this subscription.',
          );
        }
      } catch {
        return pageResponse(request, 500, 'Something went wrong', 'Something went wrong. Try again shortly.');
      }

      // Safety: direct interpolation of token into HTML is safe because it is strictly validated by TOKEN_RE above.
      return pageResponse(
        request,
        200,
        'Confirm unsubscribe',
        safeHtml(`Click below to confirm unsubscribing from Blowhorn updates.<br><br>\n<form method="POST" action="/api/unsubscribe">\n<input type="hidden" name="token" value="${token}">\n<button type="submit">Confirm unsubscribe</button>\n</form>`),
      );
    }

    if (isUnsubscribePost) {
      let token = url.searchParams.get('token') || '';
      if (!token) {
        const fields = await readFields(request);
        if (fields && fields.tooLarge) {
          return fail(request, 413, 'Payload too large.', null);
        }
        if (fields && typeof fields.token === 'string') {
          token = fields.token.trim();
        }
      }
      if (!token || !TOKEN_RE.test(token)) {
        return pageResponse(
          request,
          400,
          'Unsubscribe link incomplete',
          'This unsubscribe link is missing its key. Use the link from the email you got.',
        );
      }
      try {
        const row = await db.getByToken(token);
        if (!row) {
          return pageResponse(
            request,
            404,
            'Unsubscribe link not recognized',
            'No subscription matches this link. It may be from an older email, or the link may be incomplete.',
          );
        }
        if (!row.unsubscribed_at) await db.markUnsubscribed(token);
      } catch {
        return pageResponse(request, 500, 'Something went wrong', 'Something went wrong. Try again shortly.');
      }
      return pageResponse(
        request,
        200,
        'Unsubscribed',
        'You are unsubscribed. You will get no more emails from this subscription.',
      );
    }

    if (isSupport) {
      const supportFields = await readFields(request);
      if (supportFields && supportFields.tooLarge) {
        return fail(request, 413, 'Payload too large.', null);
      }
      if (!supportFields) return fail(request, 400, 'Could not read the message.', null);
      // Honeypot: a filled trap field means a bot. Answer success without storing.
      if (typeof supportFields.website === 'string' && supportFields.website.trim() !== '') {
        if (isFormPost(request)) return Response.redirect(SUPPORT_THANKS_URL, 303);
        return jsonResponse(request, 200, { ok: true });
      }
      const validSupport = validateSupport(supportFields);
      if (validSupport.error) return fail(request, 400, validSupport.error, validSupport.sourcePage || supportFields.source_page);
      const creationProof = randomCreationProof();
      let supportId = null;
      try {
        supportId = await db.insertSupportMessage({
          name: validSupport.name,
          email: validSupport.email,
          subject: validSupport.subject,
          message: validSupport.message,
          details: validSupport.details,
          created_at: new Date().toISOString(),
          source_page: validSupport.sourcePage,
          reason: validSupport.reason,
          contact_preference: validSupport.contactPreference,
          diagnostics_reference: validSupport.diagnosticsReference,
          case_number: validSupport.caseNumber,
          creation_proof: creationProof,
        });
      } catch {
        return fail(request, 500, 'Something went wrong.', validSupport.sourcePage);
      }
      const forwarded = await forwardSupport(forward, {
        case_number: validSupport.caseNumber,
        reason: validSupport.reason,
        contact_preference: validSupport.contactPreference,
        message: validSupport.message,
        details: validSupport.details,
        diagnostics_reference: validSupport.diagnosticsReference,
        email: validSupport.email,
        name: validSupport.name,
        creation_proof: creationProof,
      });
      if (forwarded.attempted && supportId !== null) {
        try {
          if (forwarded.ok) await db.markSupportForwarded(supportId);
          else await recordFailure(db, { id: supportId, forward_attempts: 0 }, forwarded.status, Date.now());
        } catch {
          // The row stands either way; only the replay bookkeeping is lost.
        }
      }
      if (isFormPost(request)) return Response.redirect(SUPPORT_THANKS_URL, 303);
      return jsonResponse(request, 200, { ok: true });
    }

    const kind = isWaitlist ? 'waitlist' : 'newsletter';
    const fields = await readFields(request);
    if (fields && fields.tooLarge) {
      return fail(request, 413, 'Payload too large.', null);
    }
    if (!fields) return fail(request, 400, 'Could not read the signup.', null);
    // Honeypot: a filled trap field means a bot. Answer success without storing.
    if (typeof fields.website === 'string' && fields.website.trim() !== '') {
      if (isFormPost(request)) return Response.redirect(THANKS_URL, 303);
      return jsonResponse(request, 200, { ok: true });
    }
    const valid = validateSignup(kind, fields);
    if (valid.error) return fail(request, 400, valid.error, valid.sourcePage || fields.source_page);
    try {
      const existing = await db.getSignup(valid.email, kind, valid.topic);
      if (existing) {
        await db.updateSignup({
          email: valid.email,
          kind,
          topic: valid.topic,
          remark: valid.remark,
          source_page: valid.sourcePage,
        });
      } else {
        await db.insertSignup({
          email: valid.email,
          kind,
          topic: valid.topic,
          remark: valid.remark,
          token: randomToken(),
          created_at: new Date().toISOString(),
          source_page: valid.sourcePage,
        });
      }
    } catch {
      return fail(request, 500, 'Something went wrong.', valid.sourcePage);
    }
    if (isFormPost(request)) return Response.redirect(THANKS_URL, 303);
    return jsonResponse(request, 200, { ok: true });
  };
}

export function createScheduledHandler(db, clock = () => Date.now(), options = {}) {
  const forward = options.forward || null;
  return async function handleScheduled(event) {
    const timestamp = typeof event?.scheduledTime === 'number' && event.scheduledTime > 0
      ? event.scheduledTime
      : clock();
    const currentWindow = Math.floor(timestamp / 60000);
    let pruneError = null;
    try {
      await db.pruneRateLimits(currentWindow);
    } catch (err) {
      pruneError = err;
    }
    // The retry runs even when pruning failed, and a retry failure never
    // hides a prune failure.
    try {
      await retryUnforwardedSupport(db, forward, timestamp);
    } catch (err) {
      console.error('support retry failed', err && err.message);
    }
    if (pruneError) throw pruneError;
  };
}

export default {
  fetch(request, env) {
    return createHandler(d1Db(env.SIGNUPS_DB), { forward: supportForwardFromEnv(env) })(request);
  },
  scheduled(event, env) {
    return createScheduledHandler(d1Db(env.SIGNUPS_DB), undefined, { forward: supportForwardFromEnv(env) })(event);
  },
};
