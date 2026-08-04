'use strict';
const { loadEnvFileOnce, getEnv } = require('../core/config');
loadEnvFileOnce();
const { TorrentScraper } = require('../uplayer');
const { createTmdbClient } = require('../core/tmdb-client');
const { createEpisodeNumberingService } = require('../core/episode-numbering');
const s = new TorrentScraper();
const key = getEnv('TMDB_API_KEY', '') || process.env.TMDB_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Uses the SAME profile derivation as server.js /api/torrents/search (core/episode-numbering)
// so this bench cannot drift from production behaviour.
const client = createTmdbClient(key);
const svc = createEpisodeNumberingService({ tmdb: (e, p) => client.get(e, p) });

async function run(label, id, title, sNum, eNum) {
  console.log('\n==== ' + label + ' ====');
  const p = await svc.buildProfile(id, sNum, eNum);
  console.log('isAnime=' + p.isAnime + ' | absoluteEpisode=' + p.absoluteEpisode
    + ' | altTitles=' + JSON.stringify(p.altTitles)
    + ' | seasonTitles=' + JSON.stringify(p.seasonTitles)
    + ' | seAliases=' + JSON.stringify(p.seAliases));
  for (const t of [title, ...p.altTitles, ...p.seasonTitles]) {
    const sp = await s.searchSubsPlease(t).catch(() => []);
    await sleep(2500);
    const ny = await s.searchNyaa(`${t} ${p.absoluteEpisode}`).catch(() => []);
    await sleep(2500);
    console.log(`  "${t}"  -> SubsPlease ${sp.length} | Nyaa "${t} ${p.absoluteEpisode}" ${ny.length}`);
  }
}

(async () => {
  if (!key) { console.log('no TMDB key'); return; }
  await run('MASHLE S01E14', 204832, 'MASHLE: MAGIC AND MUSCLES', 1, 14);
  await run('Bleach TYBW S02E14', 30984, 'Bleach', 2, 14);
})();
