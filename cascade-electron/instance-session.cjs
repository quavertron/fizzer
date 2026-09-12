'use strict';

// Exchange an existing instance token for that instance's browser cookie.
// A successful HTTP response alone is insufficient: /session also returns 200
// for unauthenticated callers.
async function resumeInstanceSession(origin, token, { fetch: request = fetch, cookies }) {
  const response = await request(`${origin}/api/session`, {
    headers: { authorization: `Bearer ${token}`, 'x-cascade-session-migrate': '1' },
    signal: AbortSignal.timeout(5_000), redirect: 'manual',
  });
  const body = await response.json();
  if (!response.ok || !body.authenticated || !body.user) throw new Error('Sign in to this instance again.');
  const values = response.headers.getSetCookie();
  if (!values.length) throw new Error('This instance did not establish a browser session.');
  for (const cookie of values) {
    const first = cookie.split(';', 1)[0];
    const at = first.indexOf('=');
    if (at < 1) continue;
    await cookies.set({ url: `${origin}/`, name: first.slice(0, at),
      value: decodeURIComponent(first.slice(at + 1)), path: '/',
      httpOnly: true, secure: origin.startsWith('https:') });
  }
  return body.user;
}

module.exports = { resumeInstanceSession };
