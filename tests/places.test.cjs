const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
function backend(payload = { status: 'OK', results: [] }, statusCode = 200) {
  const requests = [];
  const context = { exports: {}, URLSearchParams, process: { env: { GOOGLE_API_KEY: 'test-key' } }, require: () => ({
    get(url, callback) {
      requests.push(new URL(url));
      const req = new EventEmitter();
      req.setTimeout = () => {};
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = statusCode; res.setEncoding = () => {};
        callback(res); res.emit('data', JSON.stringify(payload)); res.emit('end');
      });
      return req;
    },
  }) };
  vm.runInNewContext(readFileSync(new URL('../netlify/functions/places.js', `file://${__filename}`), 'utf8'), context);
  return { call: params => context.exports.handler({ httpMethod: 'GET', queryStringParameters: params }), requests };
}
test('address search uses text search and returns only candidate fields', async () => {
  const api = backend({status:'OK',results:[{name:'Station',geometry:{location:{lat:25,lng:121}},formatted_address:'Taipei',photos:['unused']}]});
  const response = await api.call({action:'location',query:'台北車站'});
  assert.equal(response.statusCode, 200);
  assert.equal(api.requests[0].pathname, '/maps/api/place/textsearch/json');
  assert.equal(api.requests[0].searchParams.get('query'), '台北車站');
  assert.equal(JSON.parse(response.body).results[0].photos, undefined);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});
test('nearby search forwards selected radius and rejects invalid input', async () => {
  const api = backend();
  assert.equal((await api.call({location:'25,121',radius:'1600',type:'cafe'})).statusCode, 200);
  assert.equal(api.requests[0].searchParams.get('radius'), '1600');
  for (const params of [{location:'91,121'}, {location:',121'}, {location:'25,121',radius:'NaN'}, {location:'25,121',type:'invalid'}, {action:'location',query:''}]) {
    assert.equal((await api.call(params)).statusCode, 400);
  }
  assert.equal(api.requests.length, 1);
});
test('upstream HTTP errors are returned as service errors', async () => {
  const api = backend({}, 503);
  assert.equal((await api.call({location:'25,121'})).statusCode, 502);
});
