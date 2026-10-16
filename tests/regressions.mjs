// Browser regression tests for index.html. Run with `npm test`.
// CDN scripts are stubbed so the suite runs offline; mp4-muxer is served from node_modules.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = http.createServer(async (req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
        const body = await fs.readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise(r => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

// Wraps the real muxer so tests can swap H.264/AAC (not shipped in open-source Chromium) for VP9/Opus.
const MUXER_SHIM = `
import * as M from '${BASE}/node_modules/mp4-muxer/build/mp4-muxer.mjs';
export const ArrayBufferTarget = M.ArrayBufferTarget;
export class Muxer extends M.Muxer {
    constructor(o) {
        if (window.__codecShim) {
            o = { ...o,
                video: o.video && { ...o.video, codec: o.video.codec === 'avc' ? 'vp9' : o.video.codec },
                audio: o.audio && { ...o.audio, codec: o.audio.codec === 'aac' ? 'opus' : o.audio.codec } };
        }
        super(o);
    }
}`;

const CODEC_SHIM = () => {
    window.__codecShim = true;
    const swap = { 'avc1.420034': 'vp09.00.10.08', 'mp4a.40.2': 'opus' };
    for (const Enc of [VideoEncoder, AudioEncoder]) {
        const configure = Enc.prototype.configure;
        Enc.prototype.configure = function (c) { return configure.call(this, { ...c, codec: swap[c.codec] || c.codec }); };
    }
};

const browser = await chromium.launch();

const newPage = async ({ codecShim = false } = {}) => {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType: 'text/javascript',
        // The app toggles Tailwind's .hidden class for state, so keep that one rule.
        body: "document.head.insertAdjacentHTML('beforeend','<style>.hidden{display:none!important}</style>');" }));
    await context.route('https://unpkg.com/lucide**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.lucide={createIcons(){}};' }));
    await context.route('https://esm.sh/mp4-muxer**', r => r.fulfill({ contentType: 'text/javascript', body: MUXER_SHIM }));
    const page = await context.newPage();
    if (codecShim) await page.addInitScript(CODEC_SHIM);
    page.on('pageerror', e => console.log('    [pageerror]', e.message));
    await page.addInitScript(() => localStorage.setItem('flux_onboarding_hide', '1'));
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => typeof db !== 'undefined' && db);
    return { context, page };
};

const answerModal = async (page, value) => {
    await page.waitForSelector('#modal-container:not(.hidden)');
    await page.fill('#modal-input', value);
    await page.$eval('#modal-confirm', b => b.click());
};

const createProject = async (page, name = 'Test') => {
    await page.click('#btn-new-project');
    await answerModal(page, name);
    await page.waitForFunction(() => currentProject);
    return page.evaluate(() => currentProject.id);
};

// Builds a VP9/Opus MP4 in the page: solid-colour frames plus a 440 Hz tone.
const makeFixture = (page, { width, height, color, seconds }) => page.evaluate(async ({ width, height, color, seconds, base }) => {
    const { Muxer, ArrayBufferTarget } = await import(`${base}/node_modules/mp4-muxer/build/mp4-muxer.mjs`);
    const fps = 30, rate = 48000;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: 'in-memory',
        video: { codec: 'vp9', width, height }, audio: { codec: 'opus', numberOfChannels: 2, sampleRate: rate } });
    const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { throw e; } });
    ve.configure({ codec: 'vp09.00.10.08', width, height, bitrate: 500_000, framerate: fps });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < seconds * fps; i++) {
        ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
        const f = new VideoFrame(canvas, { timestamp: i * 1e6 / fps, duration: 1e6 / fps });
        ve.encode(f, { keyFrame: i % 30 === 0 }); f.close();
    }
    const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { throw e; } });
    ae.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 2, bitrate: 64000 });
    const n = 960;
    for (let i = 0; i < seconds * rate; i += n) {
        const data = new Float32Array(n * 2);
        for (let k = 0; k < n; k++) data[k] = data[n + k] = 0.3 * Math.sin(2 * Math.PI * 440 * (i + k) / rate);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: i * 1e6 / rate, data });
        ae.encode(ad); ad.close();
    }
    await ve.flush(); await ae.flush(); muxer.finalize();
    return Array.from(new Uint8Array(muxer.target.buffer));
}, { width, height, color, seconds, base: BASE });

const addMedia = async (page, files) => {
    const before = await page.evaluate(() => assets.length);
    await page.setInputFiles('#media-input', files.map(f => ({ name: f.name, mimeType: 'video/mp4', buffer: Buffer.from(f.bytes) })));
    await page.waitForFunction(n => assets.length >= n, before + files.length);
};

const reloadAndOpen = async (page, projectId) => {
    await page.reload();
    await page.waitForFunction(() => typeof db !== 'undefined' && db);
    await page.selectOption('#project-selector', projectId);
    await page.waitForFunction(id => currentProject && currentProject.id === id, projectId);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Tests ──────────────────────────────────────────────────────────────────

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

test('clip drag moves the visible clip and its linked partner, and persists', async () => {
    const { context, page } = await newPage();
    const id = await createProject(page);
    await addMedia(page, [{ name: 'a.mp4', bytes: await makeFixture(page, { width: 320, height: 240, color: '#f00', seconds: 2 }) }]);
    await page.evaluate(() => { currentTime = 1; addClipToTimeline(assets[0].id); selectedClipIndex = 0; renderTimeline(); el.btnSplitAV.click(); });
    const r = await page.evaluate(() => {
        const c = document.querySelector('.clip[data-index="0"]');
        c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200 }));
        const during = {
            video: document.querySelector('.clip[data-index="0"]').style.left,
            audio: document.querySelector('.clip[data-index="1"]').style.left,
        };
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return { during, starts: timelineClips.map(c => c.start) };
    });
    assert(r.during.video === '150px', `video clip shows at ${r.during.video} during drag, expected 150px`);
    assert(r.during.audio === '150px', `linked audio clip shows at ${r.during.audio}, expected 150px`);
    assert(r.starts.every(s => s === 3), `starts ${r.starts}`);
    // The drag's own save must reach IndexedDB; poll rather than guess at commit timing.
    await page.waitForFunction(id => new Promise(r => {
        const q = db.transaction('projects').objectStore('projects').get(id);
        q.onsuccess = () => r(q.result.timelineClips.map(c => c.start).join() === '3,3');
    }), id, { timeout: 5000 });
    await reloadAndOpen(page, id);
    const starts = await page.evaluate(() => timelineClips.map(c => c.start));
    assert(starts.join() === '3,3', `after reload starts are ${starts}`);
    await context.close();
});

test('a split clip cannot be split again after one half moves', async () => {
    const { context, page } = await newPage();
    await createProject(page);
    await addMedia(page, [{ name: 'a.mp4', bytes: await makeFixture(page, { width: 320, height: 240, color: '#f00', seconds: 2 }) }]);
    const r = await page.evaluate(() => {
        addClipToTimeline(assets[0].id);
        selectedClipIndex = 0; renderTimeline(); el.btnSplitAV.click();
        timelineClips[1].start = 5; // move the audio half away
        selectedClipIndex = 0; renderTimeline();
        const disabled = el.btnSplitAV.disabled;
        el.btnSplitAV.click();
        return { disabled, count: timelineClips.length };
    });
    assert(r.disabled, 'Split A/V should stay disabled');
    assert(r.count === 2, `expected 2 clips, got ${r.count}`);
    await context.close();
});

test('range delete across a split pair keeps each piece linked to its partner', async () => {
    const { context, page } = await newPage();
    await createProject(page);
    await addMedia(page, [{ name: 'a.mp4', bytes: await makeFixture(page, { width: 320, height: 240, color: '#f00', seconds: 2 }) }]);
    const r = await page.evaluate(() => {
        addClipToTimeline(assets[0].id);
        selectedClipIndex = 0; renderTimeline(); el.btnSplitAV.click();
        selectedClipIndex = 1;
        selectionStart = 0.5; selectionEnd = 1.0;
        handleRippleDelete();
        const groups = {};
        timelineClips.forEach(c => { (groups[c.linkId] ||= []).push(getClipTrackType(c)); });
        return { groups: Object.values(groups).map(g => g.sort().join('+')), selected: selectedClipIndex };
    });
    assert(r.groups.length === 2 && r.groups.every(g => g === 'audio+video'), `link groups ${JSON.stringify(r.groups)}`);
    assert(r.selected === null, 'stale clip selection after range delete');
    await context.close();
});

test('annotation list edits survive a reload', async () => {
    const { context, page } = await newPage();
    const id = await createProject(page);
    await page.evaluate(() => {
        annotations.push({ id: 1, type: 'text', startTime: 0, endTime: 3, x: 0.5, y: 0.5, text: 'one', color: '#ff0000', fontSizeNorm: 0.05, space: 'video' });
        annotations.push({ id: 2, type: 'text', startTime: 0, endTime: 3, x: 0.2, y: 0.2, text: 'two', color: '#ff0000', fontSizeNorm: 0.05, space: 'video' });
        renderAnnotationList();
    });
    const rows = page.locator('#annotations-list .ann-row');
    await rows.nth(0).locator('.ann-text').fill('edited');
    await rows.nth(0).locator('.ann-dur').fill('5');
    await rows.nth(0).locator('input[type=color]').evaluate(e => { e.value = '#00ff00'; e.dispatchEvent(new Event('input')); });
    await rows.nth(1).locator('.ann-del').evaluate(e => e.click());
    await page.waitForFunction(id => new Promise(r => {
        const q = db.transaction('projects').objectStore('projects').get(id);
        q.onsuccess = () => r((q.result.annotations || []).length === 1);
    }), id, { timeout: 5000 }).catch(() => {});
    await reloadAndOpen(page, id);
    const anns = await page.evaluate(() => annotations.map(a => ({ text: a.text, color: a.color, dur: a.endTime - a.startTime })));
    assert(anns.length === 1, `expected 1 annotation, got ${anns.length}`);
    assert(anns[0].text === 'edited' && anns[0].color === '#00ff00' && anns[0].dur === 5, JSON.stringify(anns[0]));
    await context.close();
});

test('.flux round trip keeps annotations after reload', async () => {
    const { context, page } = await newPage();
    await createProject(page, 'Roundtrip');
    await addMedia(page, [{ name: 'a.mp4', bytes: await makeFixture(page, { width: 320, height: 240, color: '#f00', seconds: 1 }) }]);
    await page.evaluate(() => {
        addClipToTimeline(assets[0].id);
        annotations.push({ id: 1, type: 'text', startTime: 0, endTime: 3, x: 0.5, y: 0.5, text: 'keep me', color: '#ff0000', fontSizeNorm: 0.05, space: 'video' });
        return saveProject();
    });
    const dl = page.waitForEvent('download');
    await page.click('#btn-export-flux');
    await answerModal(page, 'pw');
    const fluxPath = await (await dl).path();

    await page.setInputFiles('#import-flux', fluxPath);
    await answerModal(page, 'pw');
    await page.waitForFunction(() => currentProject && currentProject.name.includes('(Imported)'));
    const importedId = await page.evaluate(() => currentProject.id);
    await reloadAndOpen(page, importedId);
    const texts = await page.evaluate(() => annotations.map(a => a.text));
    assert(texts.join() === 'keep me', `annotations after reload: ${JSON.stringify(texts)}`);
    await context.close();
});

test('asset names from an imported .flux are not executed as HTML', async () => {
    const { context, page } = await newPage();
    const evil = '<img src=x onerror="window.__pwned=1">clip.mp4';
    const bytes = await page.evaluate(async (name) => {
        const manifest = { project: { id: 'p', name: 'Evil' }, timelineClips: [], annotations: [],
            assets: [{ id: 'a', name, type: 'video/mp4', duration: 1, byteLength: 4 }] };
        const container = await buildFluxContainer(manifest, [new Uint8Array([0, 0, 0, 0]).buffer]);
        return Array.from(new Uint8Array(await packEncryptedFlux(container, 'pw')));
    }, evil);
    await page.setInputFiles('#import-flux', { name: 'evil.flux', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await answerModal(page, 'pw');
    await page.waitForFunction(() => assets.length === 1);
    await sleep(300);
    const r = await page.evaluate(() => ({ pwned: window.__pwned, imgs: el.assetList.querySelectorAll('img').length, text: el.assetList.textContent }));
    assert(!r.pwned && r.imgs === 0, 'markup in asset name was rendered');
    assert(r.text.includes(evil), `asset name not shown as text: ${r.text}`);
    await context.close();
});

test('export fails loudly when the encoder reports an error mid-way', async () => {
    const { context, page } = await newPage({ codecShim: true });
    await createProject(page);
    await addMedia(page, [{ name: 'a.mp4', bytes: await makeFixture(page, { width: 320, height: 240, color: '#f00', seconds: 2 }) }]);
    await page.evaluate(() => {
        addClipToTimeline(assets[0].id);
        // Fire the encoder's error callback after a few frames, the way a GPU or codec failure would.
        const Real = VideoEncoder;
        window.VideoEncoder = class extends Real {
            constructor(init) { super(init); this._err = init.error; this._n = 0; }
            encode(f, o) { if (++this._n === 10) setTimeout(() => this._err(new Error('simulated encoder failure'))); return super.encode(f, o); }
        };
    });
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.click('#btn-export');
    await page.waitForFunction(() => !isExporting, null, { timeout: 30000 });
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.innerText));
    assert(!downloaded, 'a file was downloaded despite the encoder error');
    assert(toasts.some(t => t.includes('simulated encoder failure')), `toasts: ${toasts}`);
    await context.close();
});

test('export reports an unreadable first video instead of hanging', async () => {
    const { context, page } = await newPage({ codecShim: true });
    await createProject(page);
    await page.evaluate(() => {
        const blob = new Blob(['not a video'], { type: 'video/mp4' });
        assets.push({ id: 'bad', name: 'bad.mp4', type: 'video/mp4', duration: 1, blob, url: URL.createObjectURL(blob) });
        timelineClips.push({ assetId: 'bad', start: 0, duration: 1, offset: 0 });
    });
    await page.click('#btn-export');
    await page.waitForFunction(() => !isExporting, null, { timeout: 15000 });
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.innerText));
    assert(toasts.some(t => t.includes('Could not read bad.mp4')), `toasts: ${toasts}`);
    await context.close();
});

test('export letterboxes clips with a different aspect ratio and produces playable output', async () => {
    const { context, page } = await newPage({ codecShim: true });
    await createProject(page);
    await addMedia(page, [
        { name: 'wide.mp4', bytes: await makeFixture(page, { width: 640, height: 360, color: '#00ff00', seconds: 1 }) },
        { name: 'square.mp4', bytes: await makeFixture(page, { width: 360, height: 360, color: '#ff0000', seconds: 1 }) },
    ]);
    await page.evaluate(() => {
        currentTime = 0; addClipToTimeline(assets.find(a => a.name === 'wide.mp4').id);
        currentTime = 1; addClipToTimeline(assets.find(a => a.name === 'square.mp4').id);
    });
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#btn-export');
    const outPath = await (await dl).path();
    const bytes = Array.from(await fs.readFile(outPath));
    const r = await page.evaluate(async (bytes) => {
        const v = document.createElement('video');
        v.muted = true;
        v.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
        await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('output not playable')); });
        v.currentTime = 1.5;
        await new Promise(res => { v.onseeked = res; });
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0);
        const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
        return { w: v.videoWidth, h: v.videoHeight, duration: v.duration, edge: px(20, 180), centre: px(320, 180) };
    }, bytes);
    assert(r.w === 640 && r.h === 360, `output is ${r.w}x${r.h}`);
    assert(Math.abs(r.duration - 2) < 0.2, `duration ${r.duration}`);
    assert(r.edge.every(c => c < 30), `pillarbox edge should be black, got ${r.edge}`);
    assert(r.centre[0] > 200 && r.centre[1] < 60, `centre should be red, got ${r.centre}`);
    await context.close();
});

// ─── Runner ─────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
    try {
        await t.fn();
        console.log(`  ✓ ${t.name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${t.name}\n      ${e.message}`);
    }
}
await browser.close();
server.close();
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
