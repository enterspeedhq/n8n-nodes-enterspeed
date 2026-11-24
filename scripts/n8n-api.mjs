// The bits of n8n's internal /rest/* API the scripts and the e2e share. The API
// is unversioned and private; the image pinned in docker-compose.yml keeps it
// stable, so revisit these after any n8n image version bump.

const EMAIL = 'runner@n8n.local';
const PASSWORD = 'N8nRunner99!';

/**
 * Sets up the owner account on a fresh instance (a no-op once it exists) and
 * signs in. Returns the headers that authenticate a request. n8n allows five
 * sign-ins a minute per account, and a run of the e2e signs in once per case,
 * so a 429 waits out the minute and tries again.
 */
export async function signIn(n8nUrl) {
  const post = (path, body) =>
    fetch(`${n8nUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  await post('/rest/owner/setup', { email: EMAIL, password: PASSWORD, firstName: 'CI', lastName: 'Runner' });
  let loginRes = await post('/rest/login', { emailOrLdapLoginId: EMAIL, password: PASSWORD });
  for (let attempt = 0; loginRes.status === 429 && attempt < 2; attempt++) {
    console.log('Too many sign-ins; waiting a minute...');
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    loginRes = await post('/rest/login', { emailOrLdapLoginId: EMAIL, password: PASSWORD });
  }
  if (!loginRes.ok) throw new Error(`Login failed: ${await loginRes.text()}`);
  const cookie = loginRes.headers.get('set-cookie')?.match(/n8n-auth=[^;]+/)?.[0];
  if (!cookie) throw new Error('No auth cookie in login response');
  return { Cookie: cookie };
}

/**
 * n8n stores an execution's data in `flatted` form: a JSON array whose first
 * entry is the root, with every string and object replaced by the index (as a
 * string) of the entry holding it.
 */
export function unflatten(text) {
  const entries = JSON.parse(text);
  const revived = new Map();
  const revive = (value) => {
    if (typeof value === 'string') {
      const entry = entries[Number(value)];
      if (typeof entry !== 'object' || entry === null) return entry;
      if (revived.has(value)) return revived.get(value);
      const copy = Array.isArray(entry) ? [] : {};
      revived.set(value, copy);
      for (const [key, inner] of Object.entries(entry)) copy[key] = revive(inner);
      return copy;
    }
    if (typeof value === 'object' && value !== null) {
      const copy = Array.isArray(value) ? [] : {};
      for (const [key, inner] of Object.entries(value)) copy[key] = revive(inner);
      return copy;
    }
    return value;
  };
  return revive('0');
}

/** A finished execution as { status, error, nodes: { [node]: run data } }. */
export function summarise(status, execution) {
  const data = typeof execution?.data === 'string' ? unflatten(execution.data) : execution?.data;
  const error = data?.resultData?.error;
  return {
    status,
    error: error ? [error.message, error.description].filter(Boolean).join(' ') : null,
    nodes: data?.resultData?.runData ?? {},
  };
}
