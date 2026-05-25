const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const GKEY = process.env.GOOGLE_API_KEY;
  if (!GKEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing API key' }) };
  }

  const params = event.queryStringParameters || {};
  const qs = new URLSearchParams({
    location: params.location || '',
    radius:   params.radius   || '800',
    type:     params.type     || 'restaurant',
    language: 'zh-TW',
    key:      GKEY,
  });
  if (params.keyword) qs.set('keyword', params.keyword);

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${qs}`;

  try {
    const data = await httpsGet(url);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
