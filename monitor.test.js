import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rate, extract, transition, PROVIDERS} from './worker.js';
const now = '2026-09-29T20:00:00Z';
const readings = (values = [985, 997.02995, 991.6]) => Object.fromEntries(PROVIDERS.map((n,i) => [n, {ok:true, rate:values[i], observedAt:now, ...(i === 2 ? {mobileRate:996.96} : {})}]));
test('rejects placeholders, non-finite values, zero and negative quotes', () => {
  for (const n of [null, '', true, 0, -1, 'Cargando...', 'NaN', Infinity]) assert.throws(() => rate(n));
  assert.equal(rate(991.60000000000002),991.6);
});
test('first observation produces a baseline and no invented previous rate', () => {
  const r = transition(null, readings(), now, 'one');
  assert.equal(r.changes.length,0); assert.match(r.message,/Monitor iniciado/);
  assert.match(r.message,/Tasa más alta: Curiara/);
  assert.equal(transition(r.state, readings(), now, 'two').message,null);
});
test('simultaneous changes have no false chronological winner', () => {
  const baseline = transition(null,readings(),now,'one').state;
  const r = transition(baseline,readings([990,1000,991.6]),now,'two');
  assert.equal(r.changes.length,2); assert.match(r.message,/Orden real indeterminado/);
  assert.equal(r.changes[0].delta,5);
});
test('failed sources are excluded, previous value retained, recovery announced', () => {
  const baseline = transition(null,readings(),now,'one').state;
  const failed = readings(); failed.Curiara = {ok:false,error:'timeout',observedAt:now};
  const r = transition(baseline,failed,now,'two');
  assert.equal(r.state.providers.Curiara.rate,997.02995);
  assert.match(r.message,/comparación incompleta/); assert.match(r.message,/RemittVen · 991,6/);
  assert.equal(transition(r.state,failed,now,'three').message,null);
  assert.match(transition(r.state,readings(),now,'four').message,/recuperada/);
});
test('wrong currencies and stale cached RemittVen data rejected', async () => {
  await assert.rejects(extract('CambiaTusEuros',async()=>({rate:100,currency_from:'USD',currency_to:'BS'})),/wrong_currency/);
  await assert.rejects(extract('RemittVen',async()=>({ok:true,rates:{account:991,mobile_transfer:997},updated_at:1})),/stale_source/);
});
test('Curiara chooses Spain, VES and bank explicitly rather than first array item', async () => {
  const get = async url => {
    if (url.endsWith('GetCurrenciesFrom')) return [{CountryISO:'it',CurrencyInitial:'EUR',CountryId:7},{CountryISO:'es',CurrencyInitial:'EUR',CountryId:5}];
    if (url.includes('GetCurrenciesTo?countryFrom=5&currencyFrom=EUR')) return [{CountryISO:'ve',CurrencyInitial:'VES',CurrencyBranchId:87}];
    if (url.endsWith('GetDeliveryTypes/87')) return [{PaymentName:'Bank',DeliveryTypeId:11}];
    assert.ok(url.endsWith('GetBestQuotation/87/11'));
    return {SellRates:997.02995,IsIndicativeRate:false,RequiresProviderValidation:false};
  };
  assert.equal((await extract('Curiara',get)).rate,997.02995);
});
test('mobile-only change is announced separately with variation', () => {
  const baseline = transition(null,readings(),now,'one').state;
  const next = readings(); next.RemittVen.mobileRate = 1000;
  const result = transition(baseline,next,now,'two');
  assert.match(result.message,/Pago Móvil: 996,96 → 1000/);
  assert.equal(result.changes.length,0);
});
