import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {run} from './worker.js';

function database() {
  const sql = new DatabaseSync(':memory:');
  const wrap = (query,args=[]) => ({
    bind(...values) { return wrap(query,values); },
    async run() { const result = sql.prepare(query).run(...args); return {meta:{changes:Number(result.changes)}}; },
    async first() { return sql.prepare(query).get(...args); },
    async all() { return {results:sql.prepare(query).all(...args)}; }
  });
  return {sql, prepare:wrap, async batch(statements) {
    sql.exec('BEGIN');
    try { const values = []; for (const s of statements) values.push(await s.run()); sql.exec('COMMIT'); return values; }
    catch(e) { sql.exec('ROLLBACK'); throw e; }
  }};
}
test('history and outbox survive delivery failure; retry does not duplicate observations or notifications', async () => {
  const DB = database(), originalFetch = globalThis.fetch;
  let deliveryWorks = false, deliveries = 0;
  globalThis.fetch = async url => {
    if (url.includes('api.telegram.org')) { deliveries++; return Response.json(deliveryWorks ? {ok:true,result:{message_id:123}} : {ok:false}, {status:deliveryWorks ? 200 : 500}); }
    if (url.includes('api.cambiatuseuros')) return Response.json({rate:985,currency_from:'EUR',currency_to:'BS'});
    if (url.includes('remittven')) return Response.json({ok:true,updated_at:Math.floor(Date.now()/1000),rates:{account:991.6,mobile_transfer:996.96}});
    if (url.endsWith('GetCurrenciesFrom')) return Response.json([{CountryISO:'es',CurrencyInitial:'EUR',CountryId:5}]);
    if (url.includes('GetCurrenciesTo')) return Response.json([{CountryISO:'ve',CurrencyInitial:'VES',CurrencyBranchId:87}]);
    if (url.includes('GetDeliveryTypes')) return Response.json([{PaymentName:'Bank',DeliveryTypeId:11}]);
    return Response.json({SellRates:997.02995,IsIndicativeRate:false,RequiresProviderValidation:false});
  };
  const env = {DB,TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_CHAT_ID:'test-only'};
  try {
    await assert.rejects(run(env),/telegram_delivery_not_confirmed/);
    assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM history').get().n,1);
    assert.equal(DB.sql.prepare('SELECT sent_at FROM outbox').get().sent_at,null);
    deliveryWorks = true;
    await run(env);
    assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM history').get().n,2);
    assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,1);
    assert.ok(DB.sql.prepare('SELECT sent_at FROM outbox').get().sent_at);
    await run(env);
    assert.equal(deliveries,2);
    DB.sql.prepare('UPDATE lease SET expires=? WHERE id=1').run(Date.now()+100000);
    assert.deepEqual(await run(env),{skipped:'already_running'});
  } finally { globalThis.fetch = originalFetch; DB.sql.close(); }
});
