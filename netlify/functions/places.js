const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('Google Places service unavailable'));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid response from Google Places')); }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('Google Places request timed out')));
    req.on('error', reject);
  });
}

function response(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed' });
  const params = event.queryStringParameters || {};
  const isLocation = params.action === 'location';
  if (params.action && !isLocation) return response(400, { error: 'Unknown action' });
  const qs = new URLSearchParams({ language: 'zh-TW' });

  if (isLocation) {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query || query.length > 200) return response(400, { error: '請輸入 1 至 200 字的地址或地點' });
    qs.set('query', query);
  } else {
    const coords = String(params.location || '').split(',');
    const [lat, lng] = coords.map(Number);
    const radius = Number(params.radius || 800);
    if (coords.length !== 2 || coords.some(value => !value.trim()) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return response(400, { error: 'Invalid location' });
    }
    if (!Number.isFinite(radius) || radius < 1 || radius > 50000) return response(400, { error: 'Invalid radius' });
    if (!['restaurant', 'cafe'].includes(params.type || 'restaurant')) return response(400, { error: 'Invalid place type' });
    qs.set('location', `${lat},${lng}`);
    qs.set('radius', String(radius));
    qs.set('type', params.type || 'restaurant');
    if (params.keyword) qs.set('keyword', String(params.keyword).slice(0, 200));
  }
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return response(500, { error: 'Missing API key' });
  qs.set('key', key);
  const endpoint = isLocation ? 'textsearch' : 'nearbysearch';
  try {
    const data = await httpsGet(`https://maps.googleapis.com/maps/api/place/${endpoint}/json?${qs}`);
    if (isLocation) {
      // Only return the location candidates needed to choose a search centre.
      data.results = (data.results || []).slice(0, 5).map(p => ({
        name: p.name, formatted_address: p.formatted_address,
        geometry: p.geometry, place_id: p.place_id,
      }));
    }
    return response(200, data);
  } catch(e) {
    return response(502, { error: e.message });
  }
};
