// Runs only against an isolated loopback server. No real device or member database is used.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sharp = require('sharp');
const JSZip = require('jszip');
const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#126ba1' } }).jpeg().toBuffer();
const root = resolve('tmp', `hikvision-check-${randomUUID()}`);
await mkdir(root, { recursive: true });
const md5 = text => createHash('md5').update(text).digest('hex');
let mode, port, authenticated = 0, imageReads = 0, personReads = 0, faceReads = 0, searchId;
const server = http.createServer(async (req, res) => {
  const auth = Object.fromEntries([...String(req.headers.authorization).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
  if (!auth.response || mode === 'unauthorized') {
    res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="fixture", nonce="fixture-nonce", qop="auth", algorithm=MD5' }); res.end(); return;
  }
  const expected = md5(`${md5('tester:fixture:fixture-password')}:fixture-nonce:${auth.nc}:${auth.cnonce}:auth:${md5(`${req.method}:${auth.uri}`)}`);
  assert.equal(new URL(auth.uri, `http://127.0.0.1:${port}`).pathname + new URL(auth.uri, `http://127.0.0.1:${port}`).search, req.url);
  assert.equal(auth.response, expected, 'Digest authentication must be valid');
  authenticated++;
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/ISAPI/System/deviceInfo') { res.end('<DeviceInfo><model>Fixture</model><firmwareVersion>test</firmwareVersion></DeviceInfo>'); return; }
  if (req.url.startsWith('/ISAPI/AccessControl/UserInfo/Search')) {
    if (mode === 'transport-error') { req.socket.destroy(); return; }
    if (mode === 'http-error') { res.writeHead(500, { 'Content-Type': 'application/xml', 'Set-Cookie': 'session=private-cookie' }); res.end('<ResponseStatus><statusCode>4</statusCode><subStatusCode>fixtureHttpFailure</subStatusCode><name>虚构姓名13800138000</name><password>fixture-password</password></ResponseStatus>'); return; }
    if (mode === 'api-error') { res.end(JSON.stringify({ statusCode: 4, subStatusCode: 'fixtureApiFailure', nested: { password: 'fixture-password', name: '虚构姓名13800138000', customPrivateField: 'unknown-private-value' } })); return; }
    if (mode === 'malformed') { res.end('Invalid JSON with private text 虚构姓名13800138000 fixture-password'); return; }
    const cond = JSON.parse(body).UserInfoSearchCond;
    assert.equal(req.method, 'POST'); assert.equal(cond.EmployeeNoList, undefined); assert.equal(cond.fuzzySearch, undefined);
    assert.equal(cond.maxResults, 30); assert.equal(cond.searchResultPosition, personReads);
    if (searchId) assert.equal(cond.searchID, searchId); else searchId = cond.searchID;
    personReads++;
    let names = [{ employeeNo: '1', name: '无关913800138000' }, { employeeNo: '7', name: '虚构姓名13800138000' }];
    if (mode === 'space') names[1].name = '虚构姓名   13800138000 ';
    if (mode === 'wide-space') names[1].name = '虚构姓名　13800138000　';
    if (mode === 'not-found') names[1].name = '虚构姓名13800138001';
    if (mode === 'ambiguous-name') names[1].name = '虚构姓名13900139000 13800138000';
    if (mode === 'duplicate') names.push({ employeeNo: '8', name: '另一个人 13800138000' });
    if (mode === 'repeated-page') names[1] = names[0];
    const slice = mode === 'incomplete' && cond.searchResultPosition > 0 ? [] : names.slice(cond.searchResultPosition, cond.searchResultPosition + 1);
    res.end(JSON.stringify({ UserInfoSearch: { totalMatches: mode === 'missing-total' ? undefined : names.length, UserInfo: slice } })); return;
  }
  if (req.url.startsWith('/ISAPI/Intelligent/FDLib/FDSearch')) {
    assert.equal(req.method, 'POST'); assert.equal(JSON.parse(body).FPID, '7');
    faceReads++;
    res.end(JSON.stringify({ MatchList: [{ FPID: mode === 'mismatch' ? '8' : '7', faceURL: mode === 'foreign' ? 'http://example.invalid/photo.jpg' : `http://127.0.0.1:${port}/photo.jpg` }] })); return;
  }
  if (req.url === '/photo.jpg') { assert.equal(req.method, 'GET'); imageReads++; res.setHeader('Content-Type', 'image/jpeg'); res.end(jpeg); return; }
  res.writeHead(500); res.end('Unexpected request');
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
const quote = str => `'${str.replaceAll("'", "''")}'`;
try {
  for (mode of ['success', 'space', 'wide-space', 'not-found', 'ambiguous-name', 'duplicate', 'repeated-page', 'incomplete', 'missing-total', 'mismatch', 'foreign', 'unauthorized', 'http-error', 'api-error', 'malformed', 'transport-error']) {
    authenticated = 0; imageReads = 0; personReads = 0; faceReads = 0; searchId = undefined;
    const out = resolve(root, mode);
    const runner = resolve(root, `${mode}.ps1`);
    await writeFile(runner, '\ufeff' + `
$ErrorActionPreference = 'Stop'
. ${quote(resolve('scripts/hikvision-photo-check/check.ps1'))} -LoadFunctionsOnly
if ((Get-PhoneSuffix '张三13800138000') -ne '13800138000') { throw 'Phone extraction failed' }
if ((Get-PhoneSuffix '张三  13800138000 ') -ne '13800138000') { throw 'Spaced name failed' }
if ((Get-PhoneSuffix '张三　13800138000　') -ne '13800138000') { throw 'Wide space failed' }
if (Get-PhoneSuffix '张三913800138000') { throw 'Partial phone matched incorrectly' }
if (Get-PhoneSuffix '张三138001380001') { throw 'Trailing extra digit matched' }
if (Get-PhoneSuffix '张三13800138000 13900139000') { throw 'Ambiguous name matched' }
if (Get-PhoneSuffix '张三138 0013 8000') { throw 'Broken phone matched' }
$login = [Management.Automation.PSCredential]::new('tester', (ConvertTo-SecureString 'fixture-password' -AsPlainText -Force))
$null = Invoke-PhotoCheck 'http://127.0.0.1:${port}' '13800138000' $login ${quote(out)} '1'
`);
    await new Promise((done, fail) => {
      const env = { ...globalThis.process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
      const process = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], { env });
      let output = ''; process.stdout.on('data', x => output += x); process.stderr.on('data', x => output += x);
      process.on('error', fail); process.on('exit', code => code ? fail(new Error(output)) : done());
    });
    const text = (await readFile(resolve(out, 'report.json'), 'utf8')).replace(/^\ufeff/, '');
    const report = JSON.parse(text);
    const logText = await readFile(resolve(out, 'diagnostic.log'), 'utf8');
    const httpText = await readFile(resolve(out, 'http.jsonl'), 'utf8');
    const events = logText.trim().split(/\r?\n/).map(JSON.parse);
    const httpEvents = httpText.trim().split(/\r?\n/).map(JSON.parse);
    assert(events.some(e => e.event === 'run.start' && e.data.toolVersion === '1.2'));
    assert(events.some(e => e.event === 'run.end'));
    assert(httpEvents.some(e => e.event === 'http.response' && e.data.status === 401));
    assert(httpEvents.some(e => e.event === 'http.request' && e.data.digestApplied));
    const zip = await JSZip.loadAsync(await readFile(resolve(out, 'diagnostics.zip')));
    assert.deepEqual(Object.keys(zip.files).sort(), ['diagnostic.log', 'http.jsonl', 'report.json']);
    assert.equal(await zip.file('http.jsonl').async('string'), httpText);
    for (const secret of ['fixture-password', 'fixture-nonce', 'private-cookie', 'unknown-private-value', '13800138000', '13900139000', '虚构姓名', '/photo.jpg']) {
      assert(!(text + logText + httpText).includes(secret), `Diagnostic data leaked ${secret}`);
    }
    if (mode === 'http-error') assert(httpEvents.some(e => e.data.status === 500 && JSON.stringify(e.data.body).includes('fixtureHttpFailure')));
    if (mode === 'api-error') assert(httpEvents.some(e => JSON.stringify(e.data.body).includes('fixtureApiFailure')));
    if (mode === 'malformed') assert(httpEvents.some(e => e.data.body?.format === 'unparsed'));
    if (!['success', 'space', 'wide-space'].includes(mode)) assert(events.some(e => e.event === 'exception' && e.data.exceptions.length > 0));
    assert(!text.includes('fixture-password') && !text.includes('13800138000') && !text.includes('虚构姓名'), 'Report leaked private data');
    if (['success', 'space', 'wide-space'].includes(mode)) {
      assert.equal(report.photoRead, '成功', text); assert.equal(imageReads, 1);
      assert.equal(personReads, 2); assert.equal(faceReads, 1);
      assert.equal((await sharp(await readFile(resolve(out, 'sample-photo.jpg'))).metadata()).width, 8);
    } else if (mode === 'unauthorized') { assert.equal(report.deviceInfo, '未通过'); assert.equal(authenticated, 0); }
    else if (['mismatch', 'foreign'].includes(mode)) { assert.equal(report.photoRead, '未通过'); assert.equal(imageReads, 0); }
    else { assert.equal(report.personRead, '未通过', text); assert.equal(faceReads, 0); assert.equal(imageReads, 0); }
    console.log(`${mode}: PASS`);
  }
} finally { server.close(); }
