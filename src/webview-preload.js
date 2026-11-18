// Runs inside every page of the Browser tab, in an isolated world: the page's
// own scripts cannot see or call it. It only does two things:
//  - when you sign in, it tells Hostdeck the username and password you typed,
//    so Hostdeck can offer to save them (nothing is saved without asking);
//  - when you choose a saved login, it fills the sign-in form.
const { ipcRenderer } = require('electron');

function usable(input) {
  if (!input || input.disabled || input.readOnly) return false;
  const style = window.getComputedStyle(input);
  return style.display !== 'none' && style.visibility !== 'hidden' && input.offsetWidth > 0 && input.offsetHeight > 0;
}

// Find the password field and the username field just before it.
function loginFields(scope) {
  const root = scope || document;
  const passwords = [...root.querySelectorAll('input[type="password"]')].filter(usable);
  if (!passwords.length) return null;
  const password = passwords[0];
  const container = password.form || document;
  const before = [...container.querySelectorAll('input')]
    .filter((i) => usable(i) && /^(text|email|tel|)$/i.test(i.getAttribute('type') || ''))
    .filter((i) => i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  return { username: before[before.length - 1] || null, password, isChange: passwords.length > 1 };
}

let lastSent = '';
function capture(scope) {
  const f = loginFields(scope);
  if (!f || f.isChange || !f.password.value) return;
  const payload = { origin: location.origin, username: f.username ? f.username.value : '', password: f.password.value };
  const key = `${payload.origin}\n${payload.username}\n${payload.password}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.sendToHost('hd:login', payload);
}

document.addEventListener('submit', (e) => capture(e.target), true);
// Many tools sign in with a button and fetch() rather than a real form submit.
document.addEventListener('click', (e) => {
  const button = e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
  if (button) capture(button.form || document);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') capture(e.target.form || document);
}, true);

function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

ipcRenderer.on('hd:fill', (_e, login) => {
  if (!login || login.origin !== location.origin) return;
  const f = loginFields();
  if (!f) return;
  if (f.username && login.username) setValue(f.username, login.username);
  setValue(f.password, login.password);
  lastSent = `${location.origin}\n${login.username}\n${login.password}`; // don't offer to save what was just filled
  f.password.focus();
});

// Tell Hostdeck whether this page shows a sign-in form, also for pages that
// draw their form after loading.
let lastReport = null;
let timer = null;
function report() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const has = Boolean(loginFields());
    if (has === lastReport) return;
    lastReport = has;
    ipcRenderer.sendToHost('hd:fields', { origin: location.origin, hasLogin: has });
  }, 300);
}
window.addEventListener('DOMContentLoaded', () => {
  report();
  new MutationObserver(report).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'type'] });
});
ipcRenderer.on('hd:probe', () => { lastReport = null; report(); });
