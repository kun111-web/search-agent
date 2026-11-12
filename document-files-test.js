// node .document-files-test.js — real Chromium requests; no real credentials or profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  process.stdout.write(execFileSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, encoding: 'utf8', timeout: 90000,
  }));
} else {
  const { app, BaseWindow, WebContentsView, session } = require('electron');
  const http = require('node:http');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'search-agent-files-'));
  app.setPath('userData', path.join(directory, 'profile'));
  app.disableHardwareAcceleration();
  const timer = setTimeout(() => { console.error('TEST TIMEOUT'); app.exit(1); }, 75000);
  const wait = async (predicate, label) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 10000) throw new Error(`Timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  app.whenReady().then(async () => {
    const { DocumentFiles, safeName, reservePath, downloadReferrer, isPdfFile } = require('./electron/document-files');
    const { TabManager } = require('./electron/tabs');
    const requests = [], opened = [], events = [];
    let origin, pdf;
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({ url: req.url, method: req.method, cookie: req.headers.cookie, referer: req.headers.referer, body });
      if (req.url === '/page' || req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=fixture; HttpOnly; SameSite=Lax; Path=/' });
        return res.end('<title>Authenticated document test</title><p>Sample document</p>');
      }
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/document?redirect' }); return res.end(); }
      if (req.url.startsWith('/document')) {
        if (req.headers.cookie !== 'session=fixture' || req.headers.referer !== origin + '/page' ||
          (req.url.includes('post') && (req.method !== 'POST' || body !== 'ticket=fixture'))) {
          res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('No session or referer');
        }
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="fixture.pdf"' });
        return res.end(pdf);
      }
      if (req.url === '/fake.pdf') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="fake.pdf"' });
        return res.end('<html>Please log in</html>');
      }
      if (req.url === '/failed.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 500000 });
        res.write('%PDF-'); setTimeout(() => res.destroy(), 50); return;
      }
      if (req.url === '/office') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': 'attachment; filename="fixture.docx"' }); return res.end('office-fixture');
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const downloads = path.join(directory, 'downloads');
    let officeDialogs = 0;
    const docs = new DocumentFiles({ session: session.fromPartition('persist:search-agent'), downloadsDirectory: downloads,
      notify: event => events.push(event), openPdf: async file => opened.push(file),
      showMessage: async () => { officeDialogs++; return { response: 2 }; } });
    docs.register();
    const window = new BaseWindow({ show: false });
    const chrome = new WebContentsView(); window.contentView.addChildView(chrome);
    const manager = new TabManager(window, chrome, docs);
    manager.createTab(origin + '/page');
    const wc = manager.getActiveTab().view.webContents;
    await wait(() => !wc.isLoading() && wc.getURL() === origin + '/page', 'initial page');
    pdf = await wc.printToPDF({ printBackground: true });
    const js = code => wc.executeJavaScript(code, true);
    const expectPdf = async (label, action) => {
      const count = opened.length;
      await action(); await wait(() => opened.length === count + 1, label);
      assert.deepEqual(fs.readFileSync(opened.at(-1)), pdf);
      console.log('PASS ' + label);
    };
    await expectPdf('Cookie + Referer downloadURL', () => docs.downloadLink(wc, origin + '/document?direct'));
    await expectPdf('target blank preserves request', () => js(`{const a=document.createElement('a');a.href='/document?blank';a.target='_blank';document.body.append(a);a.click();}`));
    await expectPdf('POST target blank keeps body + credentials', () => js(`{const f=document.createElement('form');f.method='post';f.action='/document?post';f.target='_blank';f.innerHTML='<input name="ticket" value="fixture">';document.body.append(f);f.submit();}`));
    await expectPdf('blank popup later navigates', () => js(`{const w=window.open();w.opener=null;w.location.href='/document?delayed';}`));
    await expectPdf('redirect keeps cookies and referrer', () => js(`{const a=document.createElement('a');a.href='/redirect';a.target='_blank';document.body.append(a);a.click();}`));
    manager.activateTab([...manager.tabs.values()].find(t => t.view.webContents === wc).id);
    await js(`document.body.innerHTML='<a style="display:block;padding:20px" href="/document?background">background</a>'`);
    await expectPdf('Ctrl click background tab', () => {
      wc.sendInputEvent({ type: 'mouseDown', x: 30, y: 25, button: 'left', clickCount: 1, modifiers: ['control'] });
      wc.sendInputEvent({ type: 'mouseUp', x: 30, y: 25, button: 'left', clickCount: 1, modifiers: ['control'] });
    });
    assert.equal(requests.filter(r => r.url === '/document?background').length, 1);
    const disposition = await js(`fetch('/document?xhr').then(r=>r.headers.get('content-disposition'))`);
    assert.equal(disposition, 'inline; filename="fixture.pdf"');
    assert.equal(docs.currentDocument(wc).url, origin + '/document?xhr');
    console.log('PASS PDF.js fetch response unchanged, current PDF detected');
    await expectPdf('blob PDF download', () => js(`{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([Uint8Array.from(atob('${pdf.toString('base64')}'),c=>c.charCodeAt(0))],{type:'application/pdf'}));a.download='blob.pdf';document.body.append(a);a.click();}`));
    await expectPdf('blob PDF window.open', () => js(`{const u=URL.createObjectURL(new Blob([Uint8Array.from(atob('${pdf.toString('base64')}'),c=>c.charCodeAt(0))],{type:'application/pdf'}));void window.open(u);}`));
    await js(`void window.open('/html')`);
    await wait(() => [...manager.tabs.values()].some(t => t.view.webContents.getURL() === origin + '/html' && !t.view.webContents.isLoading()), 'HTML popup');
    console.log('PASS ordinary HTML popup');
    await js(`void window.open(URL.createObjectURL(new Blob(['<title>Blob HTML</title><p>Keep HTML</p>'],{type:'text/html'})))`);
    await wait(() => [...manager.tabs.values()].some(t => t.view.webContents.getTitle() === 'Blob HTML'), 'Blob HTML popup');
    console.log('PASS Blob HTML remains a normal page');
    const count = opened.length;
    docs.downloadLink(wc, origin + '/fake.pdf');
    await wait(() => events.some(e => e.message.includes('不是有效 PDF')), 'reject HTML as PDF');
    assert.equal(opened.length, count);
    console.log('PASS login HTML is not opened as PDF');
    docs.downloadLink(wc, origin + '/failed.pdf');
    await wait(() => events.some(e => e.message.includes('文件下载失败')), 'failed download');
    assert.equal(fs.existsSync(path.join(downloads, 'failed.pdf')), false);
    console.log('PASS interrupted download cleanup');
    docs.downloadLink(wc, origin + '/office');
    await wait(() => officeDialogs === 1, 'Office open action');
    console.log('PASS Office file offers system application');
    await docs.savePage(wc);
    assert.equal(opened.length, count + 1);
    assert.equal(isPdfFile(opened.at(-1)), true);
    console.log('PASS current webpage exported to PDF');
    assert.equal(new Set(opened).size, opened.length);
    assert.equal(requests.filter(r => r.url === '/document?post').length, 1);
    assert.equal(safeName('../CON.pdf'), '_CON.pdf');
    assert.equal(downloadReferrer('https://a.test/secret?q=1', 'https://b.test/file'), 'https://a.test/');
    assert.equal(downloadReferrer('https://a.test/secret', 'http://a.test/file'), '');
    const first = reservePath(downloads, 'duplicate.pdf'), second = reservePath(downloads, 'duplicate.pdf');
    assert.notEqual(first, second);
    console.log('PASS unique paths, safe filenames and referrer policy');
    manager.destroy(); chrome.webContents.close(); window.destroy();
    server.close(); clearTimeout(timer); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
