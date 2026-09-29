// Share: get this model onto your phone (a QR code of the page, or the model
// file through the phone's share sheet) and send the shopping list as text.

import qrcode from './vendor/qrcode/qrcode.js';
import { escapeHtml } from './format.js';

export const fileSize = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: text });
}

// A page a phone can open: served over the web, not from this computer.
export function reachableUrl(loc = location) {
  if (!/^https?:$/.test(loc.protocol)) return null;
  if (/^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/.test(loc.hostname)) return null;
  return `${loc.origin}${loc.pathname}${loc.search}`;
}

// Share through the system share sheet (phones, most laptops), else fall
// back: copy text / download the file. Resolves to what happened.
export async function shareOut({ title, text, file }) {
  try {
    if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ title, files: [file] }); return 'shared'; }
    if (!file && navigator.share) { await navigator.share({ title, text }); return 'shared'; }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
  }
  if (file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return 'downloaded';
  }
  try { await navigator.clipboard.writeText(text); return 'copied'; } catch { return 'failed'; }
}

// { title, localId, shoppingText(), modelFile() -> File } ; returns { open, close, isOpen }
export function initShare({ getTitle, localId, shoppingText, modelFile, notify }) {
  const el = document.createElement('div');
  el.id = 'share';
  el.innerHTML = '<div class="lib-box share-box"><div class="lib-head"><h2>Share</h2><button class="lib-close" title="Close (Esc)">×</button></div><div class="share-body"></div></div>';
  document.body.appendChild(el);
  const body = el.querySelector('.share-body');

  function render() {
    const url = reachableUrl();
    const appUrl = url && `${location.origin}${location.pathname}`;
    const phone = localId
      ? `<p>This model lives in this browser. Send the file over (AirDrop, Messages, email…), then add it on the phone under <b>Models</b>.</p>
         <button class="card-btn primary share-model" disabled>Packing the file…</button>
         ${appUrl ? `<p class="muted small">The app itself - scan with the camera:</p><div class="share-qr">${qrSvg(appUrl)}</div>` : ''}`
      : url
        ? `<p><b>Scan with your phone's camera</b> to open this model there:</p><div class="share-qr">${qrSvg(url)}</div><p class="muted small share-url">${escapeHtml(url)}</p>`
        : '<p>This page is running on this computer, which your phone can\'t reach. Publish it with GitHub Pages (see the README) and a QR code to scan appears here.</p>';
    const list = shoppingText();
    body.innerHTML = `
      <h3>On your phone</h3>${phone}
      <h3>Shopping list</h3>
      <pre class="share-text">${escapeHtml(list)}</pre>
      <button class="card-btn share-list">📤 Share the list</button> <button class="card-btn share-copy">Copy</button>`;
    // Read and zip the model now: the share sheet only opens straight after
    // a tap, not after waiting on a big file.
    const sendBtn = body.querySelector('.share-model');
    if (sendBtn) {
      let file = null;
      modelFile().then((f) => {
        file = f;
        sendBtn.disabled = false;
        // the size matters here: mail and messaging apps refuse big attachments
        sendBtn.textContent = `📤 Send the model (${fileSize(f.size)})`;
      }).catch(() => { sendBtn.textContent = 'Couldn\'t read the model'; });
      sendBtn.addEventListener('click', async () => {
        if (!file) return;
        const how = await shareOut({ title: getTitle(), file });
        if (how === 'downloaded') notify('Saved as a zip - send it to your phone and add it there under Models.');
      });
    }
    body.querySelector('.share-list').addEventListener('click', async () => {
      const how = await shareOut({ title: `${getTitle()} - shopping list`, text: list });
      if (how === 'copied') notify('Shopping list copied - paste it into a message.');
    });
    body.querySelector('.share-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(list); notify('Shopping list copied.'); } catch { notify('Couldn\'t copy - select the text and copy it.'); }
    });
  }
  function open() { render(); el.style.display = 'flex'; }
  function close() { el.style.display = 'none'; }
  el.querySelector('.lib-close').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  return { open, close, isOpen: () => el.style.display === 'flex' };
}
