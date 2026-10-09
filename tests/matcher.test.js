import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, compareCatalogues } from '../src/matcher.js';

const yt = (id, title, publishedAtIso) => ({ id, title, publishedAtIso });
const tv = (code, title, firstAiredIso) => ({ code, title, firstAiredIso });

test('normalization keeps isolated sequel numbers', () => {
  assert.equal(normalizeTitle('ÉPISODE #2 !'), 'episode 2');
  assert.notEqual(normalizeTitle('Le jeu #1'), normalizeTitle('Le jeu #2'));
});

test('globally reserve exact unique episodes before any fuzzy match', () => {
  const videos = [
    yt('part2', 'MAUVAISE PIOCHE 2 (ft Seb)'),
    yt('part3', 'MAUVAISE PIOCHE 3 (ft Seb)')
  ];
  const episodes = [
    tv('S2023E06', 'MAUVAISE PIOCHE (ft Seb)'),
    tv('S2024E17', 'MAUVAISE PIOCHE 3 (ft Seb)'),
    tv('S2024E19', 'MAUVAISE PIOCHE 2 (ft Seb)')
  ];
  const result = compareCatalogues(videos, episodes);
  assert.deepEqual(result.matches.map(m => [m.youtube.id, m.tvdb.code]),
    [['part2', 'S2024E19'], ['part3', 'S2024E17']]);
  assert.equal(result.matches.every(m => m.matchMethod === 'EXACT_UNIQUE'), true);
});

test('same exact title repeated across videos remains review-only', () => {
  const result = compareCatalogues(
    [yt('a', 'JE PEUX TOUT VOUS EXPLIQUER...'), yt('b', 'Je peux tout vous expliquer...')],
    [tv('S2020E27', 'JE PEUX TOUT VOUS EXPLIQUER...'), tv('S2022E13', 'Je peux tout vous expliquer...')]
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.missingFromTvdb.length, 2);
  assert.equal(result.missingFromTvdb[0].classification, 'AMBIGUOUS_EXACT_TITLE_REVIEW');
});

test('fuzzy threshold alone never proves chronological identity', () => {
  const video = yt('abc', 'un incroyable match de basket avec toto la suite');
  const episode = tv('S2025E13', 'un incroyable match de basket avec toto', '2025-07-01');
  const unknown = compareCatalogues([video], [episode]);
  assert.equal(unknown.matches.length, 0);
  assert.equal(unknown.missingFromTvdb[0].classification, 'FUZZY_REQUIRES_CHRONOLOGY_REVIEW');
  const compatible = compareCatalogues([{ ...video, publishedAtIso: '2025-07-02' }], [episode]);
  assert.equal(compatible.matches.length, 1);
  assert.equal(compatible.matches[0].matchMethod, 'FUZZY_CHRONOLOGY_VERIFIED');
  const mismatch = compareCatalogues([{ ...video, publishedAtIso: '2022-07-02' }], [episode]);
  assert.equal(mismatch.matches.length, 0);
});

test('numeric conflict is never consumed by fuzzy matcher', () => {
  const result = compareCatalogues(
    [yt('a', 'LE JEU DES FRAUDES 2 AVEC THEO')],
    [tv('S2025E01', 'LE JEU DES FRAUDES 3 AVEC THEO', '2025-10-09')]
  );
  assert.equal(result.matches.length, 0);
});
