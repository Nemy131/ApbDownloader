'use strict';
// Builds the data shipped inside the app (src/builtin/) from a data folder of a working copy:
//   author-lists.json  the post lists of the built-in authors (src/default-authors.js), without any per-user state
//   translations.json  saved translations of those posts' titles and author names, from one translation bucket
// Both hold only what the public site shows (post ids, titles, cover addresses, dates, author names) plus the translations.
//
// Usage (repository root):
//   ELECTRON_RUN_AS_NODE=1 ./vendor/electron/electron.exe tools/build-builtin.cjs [dataDir] [bucket]
//   dataDir defaults to ./data, bucket to claude:fable
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.argv[2] || path.join(root, 'data'));
const bucketName = process.argv[3] || 'claude:fable';
const defaults = require(path.join(root, 'src', 'default-authors.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));

const lists = read('author-lists.json');
const out = {}; const wanted = new Set();
for (const a of defaults) {
  const entry = lists[a.id + '|model'] || lists[a.id + '|all'];
  if (!entry || !Array.isArray(entry.works) || !entry.works.length) { console.log('no saved list for', a.name, a.id); continue; }
  const works = entry.works.filter(w => Number(w.type) === 1 && /^[A-Za-z0-9_-]{4,64}$/.test(String(w.id)))
    .map(w => ({ id: String(w.id), type: 1, title: String(w.title || ''), cover: String(w.cover || ''), date: String(w.date || ''), authorId: String(w.authorId || a.id), author: String(w.author || '') }));
  out[a.id] = { fetchedAt: entry.fetchedAt, works };
  for (const w of works) { wanted.add(w.title); if (w.author) wanted.add(w.author); }
  console.log(a.name, a.id, works.length, 'posts');
}
const saved = read('translations.json');
const bucket = (saved.buckets || {})[bucketName] || {};
const translations = {}; let missing = 0;
for (const text of wanted) { const t = bucket[text]; if (typeof t === 'string' && t && t !== text) translations[text] = t; else if (/[㐀-鿿]/u.test(text)) missing++; }
const dir = path.join(root, 'src', 'builtin');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'author-lists.json'), JSON.stringify(out) + '\n');
fs.writeFileSync(path.join(dir, 'translations.json'), JSON.stringify({ source: bucketName, entries: translations }) + '\n');
console.log('lists', Object.keys(out).length, 'authors,', Object.values(out).reduce((n, e) => n + e.works.length, 0), 'posts');
console.log('translations', Object.keys(translations).length, 'from', bucketName, '· untranslated Chinese texts', missing);
