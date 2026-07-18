'use strict';
const { getEnv, loadEnvFileOnce } = require('../core/config');
loadEnvFileOnce();
const https = require('https');
const key = getEnv('TMDB_API_KEY', '') || process.env.TMDB_API_KEY || '';

function get(path) {
  return new Promise((res, rej) => {
    https.get('https://api.themoviedb.org/3' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + key, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    }).on('error', rej);
  });
}

(async () => {
  if (!key) { console.log('No TMDB key found (config store / .env / env).'); return; }
  const id = process.argv[2] || '196950';
  const d = await get(`/tv/${id}?append_to_response=alternative_titles,external_ids`);
  console.log('name:', d.name, '| original_name:', d.original_name, '| lang:', d.original_language, '| origin:', JSON.stringify(d.origin_country), '| genres:', (d.genres || []).map((g) => g.id).join(','));
  console.log('external_ids:', JSON.stringify(d.external_ids || {}));
  console.log('alternative_titles:');
  ((d.alternative_titles && d.alternative_titles.results) || []).forEach((a) => console.log(`   [${a.iso_3166_1}] type="${a.type || ''}"  ${a.title}`));
})();
