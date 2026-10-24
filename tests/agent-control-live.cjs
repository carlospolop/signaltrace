// Live Chrome check: NODE_PATH=<playwright-core and ws node_modules> node tests/agent-control-live.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>SignalTrace load fixture</title><script>
    const ws = new WebSocket('ws://' + location.host + '/socket');
    ws.onopen = () => { for (let i = 0; i < 200; i++) ws.send(JSON.stringify({type:'client-tick',i})); };
    ws.onmessage = () => {};
    window.addEventListener('message', () => {});
    window.flood = (kind, n) => { for (let i = 0; i < n; i++) window.postMessage({type:kind,i}, '*'); };
  </script>`);
});
const wss = new WebSocketServer({server, path: '/socket'});
wss.on('connection', socket => {
  for (let i = 0; i < 5000; i++) socket.send(JSON.stringify({type:'server-tick',i}));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'signaltrace-live-'));
  const extension = path.resolve(__dirname, '../chrome');
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chromium'}),
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    let workers = context.serviceWorkers();
    if (!workers.length) workers = [await context.waitForEvent('serviceworker', {timeout: 15000})];
    const id = new URL(workers[0].url()).host;
    const control = await context.newPage();
    await control.goto(`chrome-extension://${id}/control.html`);
    await control.evaluate(() => SignalTrace.arm());
    const existingPages = new Set(context.pages());
    const tabId = await control.evaluate(() => new Promise(resolve => chrome.tabs.create({url:'about:blank'}, tab => resolve(tab.id))));
    await control.evaluate(({tabId,origin}) => SignalTrace.start(tabId, origin, {maxEvents: 100,
      filters: {postmessage: ['known-noise'], server_ws: ['server-tick']}}), {tabId,origin});
    let page = context.pages().find(candidate => !existingPages.has(candidate));
    if (!page) page = await context.waitForEvent('page', {timeout:15000});
    await control.evaluate(({tabId,origin}) => chrome.tabs.update(tabId,{url: origin}), {tabId,origin});
    await page.waitForURL(url => url.origin === origin, {timeout:15000});
    await page.waitForLoadState('domcontentloaded');
    let trackerConsoleLines = 0;
    page.on('console', message => { if (/^\[(PM|WS|EVENT)/.test(message.text())) trackerConsoleLines++; });
    await page.waitForTimeout(500);
    const sockets = await control.evaluate(tabId => SignalTrace.events(tabId, 0, 100), tabId);
    assert(sockets.events.some(e => String(e.api).includes('CDP.WebSocket')), 'CDP WebSocket frames observed');
    assert(sockets.events.some(e => String(e.api).includes('frameSent') && e.meta?.url === `${origin.replace(/^http/, 'ws')}/socket`),
      'Early CDP frames retain their socket URL');
    assert(sockets.events.every(e => !String(e.api).startsWith('WebSocket.')), 'No duplicate page WebSocket frames');
    await page.evaluate(() => { window.flood('known-noise', 10000); window.flood('useful', 1200); });
    await page.waitForTimeout(1500);
    const first = await control.evaluate(tabId => SignalTrace.events(tabId, 0, 100), tabId);
    const stats = await control.evaluate(tabId => SignalTrace.stats(tabId), tabId);
    assert(first.retained <= 100, 'Bounded ring');
    assert(first.events.length <= 100, 'Bounded page');
    assert(first.events.every(e => !String(e.payload).includes('known-noise')), 'Known noise filtered');
    assert(first.events.some(e => String(e.payload).includes('useful')), 'Useful messages retained');
    assert(first.events.every(e => e.eventType !== 'http'), 'No HTTP capture');
    assert(first.events.every(e => !String(e.payload).includes('server-tick')), 'WebSocket noise filtered');
    assert.equal(trackerConsoleLines, 0, 'No per-message console spam');
    const archive = await control.evaluate(() => new Promise(resolve => chrome.storage.local.get('persistent_archive', resolve)));
    assert.equal(archive.persistent_archive, undefined, 'No persistent archive');
    await control.evaluate(tabId => SignalTrace.configure(tabId, {filters: {postmessage: ['useful']}}), tabId);
    await control.evaluate(tabId => SignalTrace.clear(tabId), tabId);
    await page.evaluate(() => window.flood('useful', 100));
    await page.waitForTimeout(300);
    const after = await control.evaluate(tabId => SignalTrace.stats(tabId), tabId);
    const last = await control.evaluate(tabId => SignalTrace.events(tabId, 0, 100), tabId);
    assert(last.events.every(e => !String(e.payload).includes('useful')), 'Mid-session filter update');
    await control.evaluate(tabId => SignalTrace.stop(tabId), tabId);
    console.log(JSON.stringify({ok:true, origin, retained:stats.retained, counters:stats.counters,
      after:after.counters, wsObserved:true}));
  } finally {
    await context.close();
    wss.close();
    server.close();
    fs.rmSync(profile, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
