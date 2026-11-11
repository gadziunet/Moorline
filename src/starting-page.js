// The page Caddy shows while it cannot reach the panel or an app (server boot, panel update,
// a stack restarting). It lives in Caddy's config, so it works while the panel itself is down.
// It checks every few seconds and reloads once the address answers. Polish or English,
// chosen by the browser's language; light or dark, chosen by the system.

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">'
  + '<rect width="64" height="64" rx="15" fill="#123d3a"/><g fill="#6cc4ae"><rect x="13" y="26" width="38" height="7" rx="2"/>'
  + '<rect x="13" y="35" width="38" height="7" rx="2" opacity=".75"/><rect x="13" y="44" width="38" height="7" rx="2" opacity=".5"/></g>'
  + '<path d="M8 18 C22 30, 42 6, 56 18" fill="none" stroke="#f4e4c1" stroke-width="4.5" stroke-linecap="round"/></svg>';

const TEXT = {
  panel: {
    en: ['Stackmoor is starting…', 'The panel will be back in a moment. This page reloads by itself when it is ready.'],
    pl: ['Stackmoor się uruchamia…', 'Panel wróci za chwilę. Ta strona sama się odświeży, gdy będzie gotowy.'],
  },
  proxy: {
    en: ['The server is not answering…', 'Stackmoor cannot reach this server: it may be off or starting, or the address, port or certificate setting of the proxy is wrong. This page reloads by itself when it answers.'],
    pl: ['Serwer nie odpowiada…', 'Stackmoor nie może połączyć się z tym serwerem: może być wyłączony albo dopiero się uruchamia, albo adres, port lub ustawienie certyfikatu w proxy są błędne. Ta strona sama się odświeży, gdy zacznie odpowiadać.'],
  },
  app: {
    en: ['This app is starting…', 'It is not answering yet – e.g. the server has just started or the app is restarting. This page reloads by itself when it answers.'],
    pl: ['Aplikacja się uruchamia…', 'Jeszcze nie odpowiada – np. serwer dopiero wstał albo aplikacja się restartuje. Ta strona sama się odświeży, gdy zacznie odpowiadać.'],
  },
};
const HINT = { en: 'Checking every 5 s', pl: 'Sprawdzam co 5 s' };
const LONG = {
  en: 'Still not answering after 10 minutes – check it in the Stackmoor panel. Checking every 5 s',
  pl: 'Nadal nie odpowiada po 10 minutach – sprawdź to w panelu Stackmoor. Sprawdzam co 5 s',
};

/** Header that marks Caddy's own "starting" answer, so the page can tell it from the app's own 503. */
export const STARTING_HEADER = 'X-Stackmoor-Starting';

/** @param {'panel'|'app'|'proxy'} kind */
export function startingPage(kind = 'app') {
  const t = TEXT[kind] || TEXT.app;
  // No "{word}" sequences anywhere: Caddy would read them as placeholders.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<noscript><meta http-equiv="refresh" content="5"></noscript>
<title>Stackmoor</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f6f4; color: #1a1a19; }
main { text-align: center; max-width: 26rem; padding: 2rem 1.25rem; }
h1 { font-size: 1.35rem; font-weight: 600; margin: 1.1rem 0 .5rem; }
p { color: #5f5e5a; line-height: 1.6; margin: 0 0 1.25rem; }
.dots span { display: inline-block; width: 8px; height: 8px; margin: 0 3px; border-radius: 50%; background: currentColor; opacity: .25; animation: b 1.2s infinite; }
.dots span:nth-child(2) { animation-delay: .2s; } .dots span:nth-child(3) { animation-delay: .4s; }
@keyframes b { 30% { opacity: 1; } }
small { display: block; margin-top: 1.25rem; color: #888780; font-size: .75rem; }
@media (prefers-color-scheme: dark) { body { background: #151514; color: #ececea; } p { color: #b4b2a9; } small { color: #888780; } }
</style></head>
<body><main>${LOGO}
<h1 id="t">${t.en[0]}</h1><p id="d">${t.en[1]}</p>
<div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
<small id="h">${HINT.en}</small></main>
<script>
(function () {
  var T = ${JSON.stringify(t)}, H = ${JSON.stringify(HINT)}, L = ${JSON.stringify(LONG)}, since = Date.now();
  var l = (navigator.language || 'en').slice(0, 2) === 'pl' ? 'pl' : 'en';
  document.documentElement.lang = l;
  document.getElementById('t').textContent = T[l][0];
  document.getElementById('d').textContent = T[l][1];
  document.getElementById('h').textContent = H[l];
  // Ask the same address again. Anything but this very page (marked by a header) means it answers –
  // also the app's own error page or a redirect to a login on another host. replace() loads it with
  // GET, so a form that ended here is not sent again.
  setInterval(function () {
    fetch(location.href, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' }).then(function (r) {
      if (r.type === 'opaqueredirect' || !r.headers.get('${STARTING_HEADER}')) location.replace(location.href);
    }).catch(function () {});
    if (Date.now() - since > 600000) document.getElementById('h').textContent = L[l];
  }, 5000);
})();
</script></body></html>`;
}
