(() => {
  const original = window.fetch.bind(window);
  let csrf;
  const ready = original('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-bootstrap': '1' }, body: '{}' })
    .then(async (response) => { if (!response.ok) throw new Error('Unable to start a secure session'); csrf = (await response.json()).csrf; });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) return original(input, init);
    await ready;
    const headers = new Headers(init.headers || {});
    if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) headers.set('x-csrf-token', csrf);
    return original(input, { ...init, headers });
  };
})();
