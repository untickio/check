'use strict';
// untick check: plain fetch, no dependencies, no build step.
const fs = require('node:fs');

const input = (name, fallback = '') =>
  (process.env[`INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`] ?? '').trim() || fallback;
const mask = (v) => v && console.log(`::add-mask::${v}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKER = '<!-- untick-check -->';

async function call(base, token, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function start(base, token, payload) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await call(base, token, '/checks', { method: 'POST', body: JSON.stringify(payload) });
    if (r.status === 202) return r.body;
    if (r.status === 429 && attempt < 5) {
      console.log('untick is busy, trying again in 30 seconds');
      await sleep(30_000);
      continue;
    }
    const why = r.body?.error?.message ?? 'unexpected answer';
    const hint =
      r.status === 401 ? ' Check the api-token.' : r.status === 402 ? ' The API is part of Pro and Agency.' : '';
    throw new Error(`untick answered ${r.status}: ${why}.${hint}`);
  }
}

async function poll(base, token, scanId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(base, token, `/checks/${scanId}`);
    if (r.status !== 200) throw new Error(`untick answered ${r.status} while waiting for the scan.`);
    if (r.body.status === 'done' || r.body.status === 'failed') return r.body;
    if (Date.now() > until) throw new Error('The scan took longer than the timeout. Open the report to see where it got to.');
    await sleep(5000);
  }
}


function markdown(r) {
  const lines = [MARKER, '### untick check', ''];
  if (r.status === 'failed') {
    lines.push(`We couldn't scan this page: ${r.error ?? 'unknown reason'}`, '', `[Open the report](${r.reportUrl})`);
    return lines.join('\n');
  }
  lines.push(
    r.failed ? `**Failed.** ${r.failOn === 'new' ? 'New serious problems were found.' : 'Serious problems were found.'}` : '**Passed.**',
    '',
    `- Grade **${r.grade ?? '-'}**${r.score == null ? '' : ` (score ${r.score})`}`,
  );
  if (r.baseline) lines.push(`- Compared with your scan from ${r.baseline.at.slice(0, 10)}: **${r.newFindings.length}** new, **${r.blockingNew}** serious`);
  else lines.push(`- No earlier scan to compare with: **${r.blocking}** serious problems in total`);
  if (r.newFindings.length) {
    lines.push('', '**New problems**', '');
    for (const f of r.newFindings) {
      const extra = f.newDetails?.length ? ` (${f.newDetails.join(', ')})` : '';
      lines.push(`- **${f.severity}** ${f.title}${extra} on ${f.pageUrl}`);
    }
  }
  lines.push('', `[Open the full report](${r.reportUrl})`);
  return lines.join('\n');
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'untick-check',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function comment(token, body) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const number = event.pull_request?.number ?? event.number;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !number || !repo) return console.log('No pull request here, so no comment was posted.');
  const existing = (await gh(token, `/repos/${repo}/issues/${number}/comments?per_page=100`)).find((c) => c.body?.includes(MARKER));
  if (existing) await gh(token, `/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  else await gh(token, `/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

async function main() {
  const token = input('api-token');
  const url = input('url');
  if (!token || !url) throw new Error('api-token and url are required.');
  mask(token);
  const pass = input('basic-auth-pass');
  mask(pass);
  const failOn = input('fail-on', 'new');
  if (!['new', 'any'].includes(failOn)) throw new Error('fail-on must be new or any.');
  const base = input('api-base', 'https://app.untick.io/api/v1').replace(/\/+$/, '');
  const minutes = Number(input('timeout-minutes', '6'));
  const user = input('basic-auth-user');
  const siteId = input('site-id');
  const payload = {
    url,
    failOn,
    ...(siteId ? { siteId } : {}),
    ...(user && pass ? { auth: { username: user, password: pass } } : {}),
  };
  const started = await start(base, token, payload);
  console.log(`Scan started: ${started.reportUrl}`);
  const r = await poll(base, token, started.scanId, (Number.isFinite(minutes) && minutes > 0 ? minutes : 6) * 60_000);

  const md = markdown(r);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(`Status: ${r.status}  Grade: ${r.grade ?? '-'}  Serious: ${r.blocking}  New: ${r.newFindings.length}  Serious and new: ${r.blockingNew}`);
  for (const f of r.newFindings) console.log(`  new ${f.severity}: ${f.title} (${f.pageUrl})`);
  if (input('comment', 'true') === 'true') {
    await comment(input('github-token'), md).catch((e) => console.log(`::warning::Could not write the pull request comment (${e.message}).`));
  }
  if (r.status !== 'done') throw new Error(`The scan didn't finish: ${r.error ?? 'unknown reason'}`);
  if (r.failed) {
    console.log(`::error::untick found ${r.failOn === 'new' ? 'new ' : ''}serious problems: ${r.reportUrl}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exit(1);
});
