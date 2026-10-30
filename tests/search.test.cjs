const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function app(file = new URL('../index.html', `file://${__filename}`), saved = null) {
  const elements = new Map();
  function element() {
    return {
      innerHTML: '', textContent: '', style: {}, attributes: {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      focus() {}, value: '',
      appendChild() {}, replaceChildren() {}, addEventListener() {},
      setAttribute(key, value) { this.attributes[key] = value; },
    };
  }
  const timers = new Map(), requests = [], storage = new Map(saved ? [['food_cats', saved]] : []);
  let timerId = 0;
  const context = vm.createContext({
    document: {
      body: { style: {} }, querySelector: () => null,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element, createDocumentFragment: element,
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    navigator: {}, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: callback => callback(),
    URLSearchParams, AbortController, console: { error() {} },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      // Deliberately resolve even after abort to check stale-response protection.
      return new Promise(resolve => requests.push({ url, options, resolve }));
    },
  });
  const html = readFileSync(file, 'utf8');
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script, context);
  return {
    run: code => vm.runInContext(code, context), elements, requests, storage,
    finishSpin() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay >= 2200) { timers.delete(id); timer.callback(); }
      }
    },
    flush() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === 320) { timers.delete(id); timer.callback(); }
      }
    },
  };
}
const places = (name, lat = 25, lng = 121) => ({ ok: true, json: async () => ({ status: 'OK', results: [{
  name, geometry: { location: { lat, lng } },
}] }) });

// Also used to record the incumbent behavior before applying this optimization.
async function measure(file) {
  const page = app(file);
  page.run('userLat = 25; userLng = 121; selectCatFromPicker(0); selectCatFromPicker(1); selectCatFromPicker(2)');
  page.flush();
  return page.requests.length;
}
if (process.argv[2]) {
  measure(process.argv[2]).then(count => console.log(JSON.stringify({ requestsForThreeRapidSelections: count })));
} else {
  test('rapid category changes send only the final search', async () => {
    assert.equal(await measure(), 1);
  });
  test('new search aborts the previous request and ignores its late response', async () => {
    const page = app();
    page.run('userLat = 25; userLng = 121; selectedCat = categories[0]');
    const first = page.run('searchNearby()');
    const second = page.run('selectedCat = categories[1]; searchNearby()');
    assert.equal(page.requests[0].options.signal.aborted, true);
    page.requests[1].resolve(places('New restaurant'));
    await second;
    page.requests[0].resolve(places('Old restaurant'));
    await first;
    assert.match(page.elements.get('placeList').innerHTML, /New restaurant/);
    assert.doesNotMatch(page.elements.get('placeList').innerHTML, /Old restaurant/);
    assert.equal(page.elements.get('placeList').attributes['aria-busy'], 'false');
  });
  test('server failures show an error instead of an empty result', async () => {
    const page = app();
    page.run('userLat = 25; userLng = 121; selectedCat = categories[0]');
    const pending = page.run('searchNearby()');
    page.requests[0].resolve({ ok: false, status: 500 });
    await pending;
    assert.match(page.elements.get('placeList').innerHTML, /搜尋失敗/);
    assert.equal(page.elements.get('placeList').attributes['aria-busy'], 'false');
  });
  test('equator coordinates can search and API content is escaped', async () => {
    const page = app();
    page.run('userLat = 0; userLng = 121; selectedCat = categories[0]');
    const pending = page.run('searchNearby()');
    assert.equal(page.requests.length, 1);
    page.requests[0].resolve(places('<img src=x onerror=alert(1)>', 0, 121));
    await pending;
    assert.match(page.elements.get('placeList').innerHTML, /&lt;img/);
    assert.doesNotMatch(page.elements.get('placeList').innerHTML, /<img/);
  });
  test('invalid persisted categories fall back to defaults', () => {
    for (const saved of ['[]', '{}', '[1,2,3]', '["", "a", "b"]']) {
      assert.equal(app(undefined, saved).run('categories.length'), 13);
    }
  });
}


test('range change updates radius and clears old choices', () => {
  const page = app();
  page.run('userLat = 25; userLng = 121; selectedCat = categories[0]; changeRange(20)');
  assert.equal(new URLSearchParams(page.requests[0].url.split('?')[1]).get('radius'), '1600');
  assert.equal(page.run('pickedPlace'), null);
});

test('only-open filter excludes closed and unknown venues without another request', () => {
  const page = app();
  page.run(`selectedCat = categories[0]; resultsReady = true;
    nearbyPlaces = [{name:'Open',lat:25,lng:121,dist:10,isOpen:true},
    {name:'Closed',lat:25,lng:121,dist:20,isOpen:false},
    {name:'Unknown',lat:25,lng:121,dist:30}]; changeOpenOnly(true)`);
  const html = page.elements.get('placeList').innerHTML;
  assert.match(html, /Open/); assert.doesNotMatch(html, /Closed|Unknown/);
  assert.match(page.elements.get('statusBar').textContent, /1 間營業狀態不明/);
  assert.equal(page.requests.length, 0);
});

test('random choice avoids recent picks, changes venue, and persists history', async () => {
  const page = app();
  page.run(`userLat = 25; userLng = 121; resultsReady = true;
    nearbyPlaces = [{name:'A',lat:25,lng:121,dist:10,placeId:'a'},
    {name:'B',lat:25,lng:121,dist:20,placeId:'b'}];
    history = [storedPlace(nearbyPlaces[0])];`);
  await page.run('decideRestaurant()');
  assert.equal(page.run('pickedPlace.name'), 'B');
  await page.run('decideRestaurant()');
  assert.equal(page.run('pickedPlace.name'), 'A');
  assert.equal(JSON.parse(page.storage.get('food_history'))[0].placeId, 'a');
  assert.equal(page.requests.length, 0);
});

test('favorite can be saved and removed from the saved view', () => {
  const page = app();
  page.run(`nearbyPlaces = [{name:'A',lat:25,lng:121,dist:10,placeId:'a'}];
    renderPlaces(nearbyPlaces); toggleFavorite(0); switchView('favorites')`);
  assert.equal(JSON.parse(page.storage.get('food_favorites')).length, 1);
  assert.match(page.elements.get('placeList').innerHTML, /A/);
  page.run('toggleFavorite(0)');
  assert.equal(JSON.parse(page.storage.get('food_favorites')).length, 0);
  assert.match(page.elements.get('placeList').innerHTML, /還沒有收藏/);
});

test('manual coordinates work without a Google request and invalidate GPS callbacks', async () => {
  const page = app();
  page.run("document.getElementById('locationQuery').value = '25.0478,121.5170'");
  await page.run('findLocation()');
  assert.equal(page.run('userLat'), 25.0478);
  assert.equal(page.run('locationVersion'), 1);
  assert.equal(JSON.parse(page.storage.get('food_loc')).manual, true);
  assert.equal(page.requests.length, 0);
});

test('manual place search requires candidate selection and ignores older responses', async () => {
  const page = app();
  page.run("document.getElementById('locationQuery').value = '台北車站'");
  const first = page.run('findLocation()');
  const second = page.run('findLocation()');
  assert.equal(page.requests[0].options.signal.aborted, true);
  page.requests[1].resolve({ok:true,json:async()=>({status:'OK',results:[{name:'台北車站',formatted_address:'台北',geometry:{location:{lat:25,lng:121}}}]})});
  await second;
  assert.equal(page.run('userLat'), null);
  page.run('chooseLocation(0)');
  assert.equal(page.run('userLat'), 25);
  page.requests[0].resolve({ok:true,json:async()=>({status:'ZERO_RESULTS',results:[]})});
  await first;
  assert.equal(page.run('userLat'), 25);
});

test('walking URL includes the selected centre, destination ID, and walking mode', () => {
  const page = app();
  const url = new URL(page.run("userLat=25;userLng=121;mapsURL({lat:25.01,lng:121.01,placeId:'abc'},true)"));
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('travelmode'), 'walking');
  assert.equal(url.searchParams.get('origin'), '25,121');
  assert.equal(url.searchParams.get('destination_place_id'), 'abc');
});

test('results outside the selected radius are excluded', async () => {
  const page = app();
  page.run('userLat = 25; userLng = 121; selectedCat = categories[0]');
  const pending = page.run('searchNearby()');
  page.requests[0].resolve(places('Far away', 26, 122));
  await pending;
  assert.equal(page.run('nearbyPlaces.length'), 0);
});


test('a pending GPS response cannot overwrite a manually chosen centre', async () => {
  const page = app();
  page.run(`navigator.geolocation = {getCurrentPosition(success) { globalThis.gpsSuccess = success; }};
    relocate(); document.getElementById('locationQuery').value = '24,120'`);
  await page.run('findLocation()');
  page.run('gpsSuccess({coords:{latitude:25,longitude:121}})');
  assert.equal(page.run('userLat'), 24);
  assert.equal(page.run('userLng'), 120);
});

test('loading a manual location does not renew its cache timestamp or request GPS', () => {
  const page = app();
  const ts = Date.now() - 10000;
  page.storage.set('food_loc', JSON.stringify({lat:24,lng:120,manual:true,label:'Manual',ts}));
  page.run('getLocation()');
  assert.equal(page.run('userLat'), 24);
  assert.equal(JSON.parse(page.storage.get('food_loc')).ts, ts);
});

test('switching to favorites keeps late nearby results out of the saved list', async () => {
  const page = app();
  page.run('userLat = 25; userLng = 121; selectedCat = categories[0]');
  const pending = page.run('searchNearby()');
  page.run("switchView('favorites')");
  page.requests[0].resolve(places('Unrelated nearby venue'));
  await pending;
  assert.match(page.elements.get('placeList').innerHTML, /還沒有收藏/);
  assert.doesNotMatch(page.elements.get('placeList').innerHTML, /Unrelated nearby venue/);
});


test('finishing a category spin cannot overwrite the favorites view with loading UI', () => {
  const page = app();
  page.run("userLat = 25; userLng = 121; pull(); switchView('favorites')");
  page.finishSpin();
  assert.equal(page.requests.length, 0);
  assert.match(page.elements.get('placeList').innerHTML, /還沒有收藏/);
  assert.doesNotMatch(page.elements.get('placeList').innerHTML, /skeleton/);
  page.run("switchView('nearby')");
  assert.equal(page.requests.length, 1);
});
