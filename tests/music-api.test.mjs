import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { API, normalizeSource, normalizeQuality } from '../js/constants.js';

// Tests use the exported interface, known literals and fixture responses.
// No server, real music provider, player data, browser or model calls.
beforeEach((t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network forbidden in offline tests'); });
});
const urlOf = (value) => new URL(value, 'https://solara.invalid');
const response = (value) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('supported music sources remain usable', () => {
  for (const source of ['netease', 'kuwo', 'joox', 'bilibili']) assert.equal(normalizeSource(source), source);
});
test('invalid source falls back to netease', () => {
  for (const source of [undefined, null, '', 'invalid', 'NETEASE', 42]) assert.equal(normalizeSource(source), 'netease');
});
test('supported quality identifiers are preserved', () => {
  for (const quality of ['128', '192', '320', '999']) assert.equal(normalizeQuality(quality), quality);
});
test('unsupported quality falls back to 320', () => {
  for (const quality of [undefined, null, '', 'flac', '9999', 128]) assert.equal(normalizeQuality(quality), '320');
});
test('search encodes a keyword without changing its Unicode or query delimiters', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: urlOf(url), options };
    return response([{ id: 7, name: '晴天', artist: ['歌手'], album: '专辑', pic_id: 'p', url_id: 'u', lyric_id: 'l', source: 'kuwo' }]);
  });
  const result = await API.search('中文 & a?b=1', 'kuwo', 10, 2);
  assert.equal(request.url.pathname, '/proxy');
  assert.equal(request.url.searchParams.get('name'), '中文 & a?b=1');
  assert.equal(request.url.searchParams.get('source'), 'kuwo');
  assert.equal(request.url.searchParams.get('count'), '10');
  assert.equal(request.url.searchParams.get('pages'), '2');
  assert.equal(request.url.searchParams.get('types'), 'search');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.deepEqual(result, [{ id: 7, name: '晴天', artist: ['歌手'], album: '专辑', pic_id: 'p', url_id: 'u', lyric_id: 'l', source: 'kuwo' }]);
});
test('search supports empty results but rejects a non-list response', async (t) => {
  const fake = t.mock.method(globalThis, 'fetch', async () => response([]));
  assert.deepEqual(await API.search('missing'), []);
  fake.mock.mockImplementation(async () => response({ error: 'busy' }));
  await assert.rejects(API.search('busy'), /搜索结果格式错误/);
});
test('HTTP failure is surfaced instead of being treated as usable search data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(API.search('anything'), /503/);
});
test('transport rejection is surfaced without silently replacing data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture network failure'); });
  await assert.rejects(API.search('anything'), /fixture network failure/);
});
test('fetchJson preserves a non-JSON response for callers that handle text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('plain fixture text', { status: 200 }));
  assert.equal(await API.fetchJson('/proxy?types=lyric'), 'plain fixture text');
});
test('radar requests clamp limits, offsets and returned track count', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (value) => {
    seen.push(urlOf(value));
    return response({ playlist: { tracks: [
      { id: 1, name: 'One', ar: [{ name: 'A' }, { name: 'B' }], al: { name: 'Album', picUrl: 'https://fixture.invalid/cover.png', pic_str: 'cover' } },
      { id: 2, name: 'Two', ar: [], al: {} },
    ] } });
  });
  const tracks = await API.getRadarPlaylist('3778678', { limit: 1.9, offset: -3 });
  assert.equal(seen[0].searchParams.get('id'), '3778678');
  assert.equal(seen[0].searchParams.get('limit'), '1');
  assert.equal(seen[0].searchParams.get('offset'), '0');
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0], { id: 1, name: 'One', artist: 'A / B', album: 'Album', source: 'netease', lyric_id: 1, pic: 'https://fixture.invalid/cover.png', pic_id: 'cover', url_id: 1 });
  await API.getRadarPlaylist('3778678', { count: 500, offset: 2.8 });
  assert.equal(seen[1].searchParams.get('limit'), '200');
  assert.equal(seen[1].searchParams.get('offset'), '2');
});
test('radar accepts the legacy numeric limit parameter', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => {
    url = urlOf(value); return response({ playlist: { tracks: [{ id: 3, name: 'Three' }] } });
  });
  const tracks = await API.getRadarPlaylist('3779629', 5);
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(tracks[0].artist, '未知艺术家');
});
test('radar rejects absent tracks so upstream failure is not mistaken for music', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ playlist: { tracks: [] } }));
  await assert.rejects(API.getRadarPlaylist(), /No tracks found/);
});
test('song and lyric helpers use compatible default identifiers', () => {
  const stream = urlOf(API.getSongUrl({ id: 42 }));
  assert.equal(stream.pathname, '/proxy');
  assert.equal(stream.searchParams.get('types'), 'url');
  assert.equal(stream.searchParams.get('id'), '42');
  assert.equal(stream.searchParams.get('source'), 'netease');
  assert.equal(stream.searchParams.get('br'), '320');
  const lyric = urlOf(API.getLyric({ id: 42, lyric_id: 'lyric-42', source: 'kuwo' }));
  assert.equal(lyric.searchParams.get('id'), 'lyric-42');
  assert.equal(lyric.searchParams.get('source'), 'kuwo');
  const cover = urlOf(API.getPicUrl({ pic_id: 'cover-42', source: 'joox' }));
  assert.equal(cover.searchParams.get('size'), '300');
  assert.equal(cover.searchParams.get('id'), 'cover-42');
});
