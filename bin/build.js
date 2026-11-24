#!/usr/bin/env node
'use strict';
// Renders out/index.html from out/latest.json, out/history.json and (if the
// scheduled run wrote one) out/review.json.
//
//   node bin/build.js [--out <dir>]

const fs = require('fs');
const path = require('path');
const page = require('../lib/page');
const HIST = require('../lib/history');

const args = process.argv.slice(2);
const i = args.indexOf('--out');
const OUT = path.resolve(i !== -1 && args[i + 1] ? args[i + 1] : path.join(__dirname, '..', 'out'));
const read = (f) => (fs.existsSync(path.join(OUT, f)) ? fs.readFileSync(path.join(OUT, f), 'utf8') : null);

let latest = null;
try { latest = read('latest.json') ? JSON.parse(read('latest.json')) : null; }
catch (e) { console.error('out/latest.json is not valid JSON: ' + e.message); process.exit(1); }
const history = read('history.json') ? HIST.parse(read('history.json')) : HIST.empty();
let review = null;
try { review = read('review.json') ? JSON.parse(read('review.json')) : null; }
catch (e) { console.warn('ignoring out/review.json: ' + e.message); }

const html = page.render({ latest: latest, history: history, review: review });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('wrote ' + path.relative(process.cwd(), path.join(OUT, 'index.html')) + ' (' + (html.length / 1024).toFixed(1) + ' KB, ' +
  (latest ? (latest.hits || []).length + ' hits, ' : 'no run yet, ') + history.runs.length + ' runs in history' + (review ? ', review notes' : '') + ')');
