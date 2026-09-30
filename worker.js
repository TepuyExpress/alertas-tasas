// Official public calculator APIs inspected on 2026-09-29. No page fallback rates.
const CTE = 'https://api.cambiatuseuros.com/api/rate';
const CUR = 'https://app.curiara.com/api/SendMoney/';
const REM = 'https://remittven.es/api/rates.php';
export const PROVIDERS = ['CambiaTusEuros', 'Curiara', 'RemittVen'];
const numberES = n => Number(n).toLocaleString('es-ES', {maximumFractionDigits: 5});
const timeES = t => new Date(t).toLocaleString('es-ES', {timeZone: 'Europe/Madrid'});

export function rate(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw Error('invalid_rate');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw Error('invalid_rate');
  return Number(n.toFixed(5));
}
function one(items, filter) {
  if (!Array.isArray(items)) throw Error('invalid_schema');
  const matches = items.filter(filter);
  if (matches.length !== 1) throw Error('ambiguous_route');
  return matches[0];
}
export async function json(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {...options, headers: {Accept: 'application/json', 'User-Agent': 'TepuyExpressRateMonitor/1.0 (+https://github.com/TepuyExpress/alertas-tasas)', ...options.headers}, signal: AbortSignal.timeout(12000)});
      if (!res.ok) throw Error(`http_${res.status}`);
      return await res.json();
    } catch {
      if (attempt === 2) throw Error('source_unavailable_or_invalid_json');
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
export async function extract(name, get = json) {
  if (name === 'CambiaTusEuros') {
    const d = await get(CTE);
    if (d.currency_from !== 'EUR' || !['BS', 'VES'].includes(d.currency_to)) throw Error('wrong_currency');
    return {rate: rate(d.rate), source: CTE, publishedAt: d.updated_at || null, method: 'Transferencia bancaria'};
  }
  if (name === 'Curiara') {
    const from = one(await get(CUR + 'GetCurrenciesFrom'), d => d.CountryISO === 'es' && d.CurrencyInitial === 'EUR');
    const to = one(await get(CUR + `GetCurrenciesTo?countryFrom=${encodeURIComponent(from.CountryId)}&currencyFrom=EUR`), d => d.CountryISO === 've' && d.CurrencyInitial === 'VES');
    const method = one(await get(CUR + `GetDeliveryTypes/${encodeURIComponent(to.CurrencyBranchId)}`), d => d.PaymentName === 'Bank');
    const source = CUR + `GetBestQuotation/${encodeURIComponent(to.CurrencyBranchId)}/${encodeURIComponent(method.DeliveryTypeId)}`;
    const d = await get(source);
    if (d.IsIndicativeRate !== false || d.RequiresProviderValidation !== false) throw Error('unconfirmed_quote');
    return {rate: rate(d.SellRates), source, method: 'Transferencia bancaria', fees: d.Fees};
  }
  if (name === 'RemittVen') {
    const d = await get(REM);
    if (d.ok !== true || !d.rates) throw Error('invalid_schema');
    const timestamp = Number(d.updated_at) * 1000;
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300000 || Date.now() - timestamp > 7200000) throw Error('stale_source');
    return {rate: rate(d.rates.account), mobileRate: rate(d.rates.mobile_transfer), source: REM, method: 'Transferencia bancaria', sourceCacheAt: new Date(timestamp).toISOString()};
  }
  throw Error('unknown_provider');
}
export async function collect(get = json) {
  const results = await Promise.all(PROVIDERS.map(async name => {
    try { return [name, {ok: true, ...(await extract(name, get)), observedAt: new Date().toISOString()}]; }
    catch (e) { return [name, {ok: false, error: e.message, observedAt: new Date().toISOString()}]; }
  }));
  return Object.fromEntries(results);
}

export function transition(previous, readings, now, id, force = false) {
  const state = structuredClone(previous || {providers: {}});
  const changes = [], lines = [];
  const initial = !previous;
  for (const name of PROVIDERS) {
    const r = readings[name], old = state.providers[name];
    if (!r.ok) {
      if (!old?.failed) lines.push(`⚠️ ${name}: consulta fallida; su última tasa no participa en el ranking.`);
      state.providers[name] = {...old, failed: true};
      continue;
    }
    if (old?.failed) lines.push(`✅ ${name}: consulta recuperada.`);
    if (old?.rate != null && old.rate !== r.rate) {
      const delta = r.rate - old.rate;
      const change = {provider: name, previous: old.rate, current: r.rate, delta, percent: delta / old.rate * 100, after: old.observedAt, by: r.observedAt};
      changes.push(change);
      lines.push(`${name}: ${numberES(old.rate)} → ${numberES(r.rate)} Bs/€ (${delta >= 0 ? '+' : ''}${numberES(delta)}; ${numberES(change.percent)} %).\nDetectado entre ${timeES(old.observedAt)} y ${timeES(r.observedAt)}.`);
    } else if (old?.rate == null) lines.push(`${name}: primera lectura ${numberES(r.rate)} Bs/€.`);
    if (old?.mobileRate != null && r.mobileRate != null && old.mobileRate !== r.mobileRate) {
      const delta = r.mobileRate - old.mobileRate;
      lines.push(`RemittVen · Pago Móvil: ${numberES(old.mobileRate)} → ${numberES(r.mobileRate)} Bs/€ (${delta >= 0 ? '+' : ''}${numberES(delta)}; ${numberES(delta / old.mobileRate * 100)} %).`);
    }
    state.providers[name] = {...r, failed: false};
  }
  const valid = PROVIDERS.filter(n => readings[n].ok);
  const max = Math.max(...valid.map(n => readings[n].rate));
  const leaders = valid.filter(n => readings[n].rate === max);
  if (changes.length) {
    lines.push(changes.length === 1
      ? `Primer cambio detectado en esta revisión: ${changes[0].provider}. No prueba el orden real entre revisiones.`
      : `Cambios detectados en la misma revisión: ${changes.map(c => c.provider).join(', ')}. Orden real indeterminado.`);
  }
  if (force) lines.unshift('Prueba real solicitada.');
  let message = null;
  if (initial || lines.length || force) {
    const ranking = valid.length ? `Tasa más alta${valid.length < 3 ? ' entre las fuentes disponibles (comparación incompleta)' : ''}: ${leaders.join(' y ')} · ${numberES(max)} Bs/€.` : 'Sin tasas verificadas; ranking no disponible.';
    const current = valid.map(n => `${n}: ${numberES(readings[n].rate)} Bs/€`).join('\n');
    const mobile = readings.RemittVen.ok ? `\nRemittVen · Pago Móvil (separado): ${numberES(readings.RemittVen.mobileRate)} Bs/€.` : '';
    message = `Tepuy Express · ${initial ? 'Monitor iniciado' : 'Alertas de tasas'}\n${timeES(now)} (Madrid)\nID: ${id}\n\n${lines.join('\n\n')}\n\n${ranking}\n${current}${mobile}\n\nEUR → VES · Transferencia bancaria. Tasas brutas; no descuentan comisiones. Horas de detección, no necesariamente de publicación.`;
  }
  state.lastRun = now;
  return {state, changes, message};
}

async function init(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, readings TEXT NOT NULL, changes TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, message TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires INTEGER)'),
    db.prepare('INSERT OR IGNORE INTO lease(id,owner,expires) VALUES(1,NULL,0)')
  ]);
}
export async function telegram(env, text) {
  // Do not log URLs, raw errors, tokens or chat IDs. No automatic retry after ambiguous delivery.
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: {is_disabled: true}}),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !result.result?.message_id) throw Error();
    return result.result.message_id;
  } catch { throw Error('telegram_delivery_not_confirmed'); }
}
export async function run(env, force = false) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw Error('missing_binding_or_secrets');
  const db = env.DB;
  await init(db);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const lock = await db.prepare('UPDATE lease SET owner=?,expires=? WHERE id=1 AND expires<?').bind(id, Date.now() + 600000, Date.now()).run();
  if (!lock.meta.changes) return {skipped: 'already_running'};
  try {
    const saved = await db.prepare('SELECT value FROM state WHERE id=1').first();
    const readings = await collect();
    const result = transition(saved ? JSON.parse(saved.value) : null, readings, now, id, force);
    const statements = [
      db.prepare('INSERT INTO history(id,observed_at,readings,changes) VALUES(?,?,?,?)').bind(id, now, JSON.stringify(readings), JSON.stringify(result.changes)),
      db.prepare('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(JSON.stringify(result.state))
    ];
    if (result.message) statements.push(db.prepare('INSERT INTO outbox(id,message) VALUES(?,?)').bind(id, result.message));
    await db.batch(statements); // Atomic observations + durable notification outbox.
    const pending = await db.prepare('SELECT id,message FROM outbox WHERE sent_at IS NULL ORDER BY rowid LIMIT 10').all();
    for (const item of pending.results) {
      await db.prepare('UPDATE outbox SET attempts=attempts+1 WHERE id=?').bind(item.id).run();
      await telegram(env, item.message);
      await db.prepare('UPDATE outbox SET sent_at=? WHERE id=?').bind(new Date().toISOString(), item.id).run();
    }
    return {id, sourcesOK: PROVIDERS.filter(n => readings[n].ok).length, notifications: pending.results.length};
  } finally {
    await db.prepare('UPDATE lease SET expires=0 WHERE id=1 AND owner=?').bind(id).run();
  }
}
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(request, env) {
    // Administration stays inside Cloudflare. No public trigger or history endpoint.
    return new Response('Tepuy Express · monitor de tasas. Administración en Cloudflare.', {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }
};
