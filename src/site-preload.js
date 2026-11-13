'use strict';
// Aplaybox uses store.js (JSON localStorage) and separately named backup cookies.
// Restore only the site's own authentication values within its own origin.
// Nothing is exposed to the application renderer, logs, or an external origin.
if (location.origin === 'https://www.aplaybox.com') {
  try {
    const cookies = Object.fromEntries(document.cookie.split(';').map(s => {const i=s.indexOf('=');return [s.slice(0,i).trim(),s.slice(i+1)];}));
    for (const key of ['user_uuid','access_token']) {
      const value=cookies[key+'_cookie'];
      if (value) localStorage.setItem(key,JSON.stringify(value));
      else if (value === '') localStorage.removeItem(key);
    }
  } catch { /* A blocked storage context must use the site's manual login. */ }
}
