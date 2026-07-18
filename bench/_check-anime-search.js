'use strict';
const { loadEnvFileOnce, getEnv } = require('../core/config');
loadEnvFileOnce();
const https = require('https');
const { TorrentScraper } = require('../uplayer');
const s = new TorrentScraper();
const key = getEnv('TMDB_API_KEY', '') || process.env.TMDB_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmdb(path) {
  return new Promise((res, rej) => {
    https.get('https://api.themoviedb.org/3' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + key, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    }).on('error', rej);
  });
}

// Replicates server.js /api/torrents/search anime derivation.
function derive(detail, seasonNum, episodeNum) {
  const genres = (detail.genres || []).map((g) => g.id);
  const origins = detail.origin_country || [];
  const isAnime = genres.includes(16) && (origins.includes('JP') || detail.original_language === 'ja');
  const altResults = (detail.alternative_titles && detail.alternative_titles.results) || [];
  const romaji = altResults.filter((a) => a && a.iso_3166_1 === 'JP' && /romaji|hepburn/i.test(a.type || '')).map((a) => a.title);
  const hasCjk = (x) => /[　-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/.test(String(x || ''));
  const origRomaji = detail.original_name && !hasCjk(detail.original_name) ? [detail.original_name] : [];
  const altTitles = [...new Set([...romaji, ...origRomaji].filter(Boolean))];
  let priorSum = 0;
  for (const ss of detail.seasons || []) if (ss && ss.season_number > 0 && ss.season_number < seasonNum) priorSum += ss.episode_count || 0;
  const absoluteEpisode = episodeNum > priorSum ? episodeNum : priorSum + episodeNum;
  return { isAnime, altTitles, absoluteEpisode };
}

async function run(label, id, title, sNum, eNum) {
  console.log('\n==== ' + label + ' ====');
  const d = await tmdb(`/tv/${id}?append_to_response=alternative_titles`);
  const { isAnime, altTitles, absoluteEpisode } = derive(d, sNum, eNum);
  console.log('isAnime=' + isAnime + ' | absoluteEpisode=' + absoluteEpisode + ' | derived altTitles=' + JSON.stringify(altTitles));
  for (const t of [title, ...altTitles]) {
    const sp = await s.searchSubsPlease(t).catch(() => []);
    await sleep(2500);
    const ny = await s.searchNyaa(`${t} ${absoluteEpisode}`).catch(() => []);
    await sleep(2500);
    console.log(`  "${t}"  -> SubsPlease ${sp.length} | Nyaa "${t} ${absoluteEpisode}" ${ny.length}`);
  }
}

(async () => {
  if (!key) { console.log('no TMDB key'); return; }
  await run('MASHLE S01E14', 204832, 'MASHLE: MAGIC AND MUSCLES', 1, 14);
  await run('Witch Hat Atelier S01E13', 196950, 'Witch Hat Atelier', 1, 13);
})();
