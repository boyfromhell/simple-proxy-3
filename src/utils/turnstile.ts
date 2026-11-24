import { H3Event, EventHandlerRequest } from 'h3';
import { SignJWT, jwtVerify } from 'jose';
import { getIp } from '@/utils/ip';
import { setting } from '@/utils/settings';

const tokenHeader = 'X-Token';
const jwtPrefix = 'jwt|';
const turnstilePrefix = 'turnstile|';

export function isTurnstileEnabled(event: H3Event) {
  const turnstileSecret = setting(event, 'TURNSTILE_SECRET');
  const jwtSecret = setting(event, 'JWT_SECRET');
  if (!!turnstileSecret !== !!jwtSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Proxy authentication is not fully configured',
    });
  }
  return !!turnstileSecret && !!jwtSecret;
}

export async function makeToken(ip: string, jwtSecret: string | undefined) {
  if (!jwtSecret) throw new Error('Cannot make token without a secret');
  return await new SignJWT({ ip })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(jwtSecret));
}

export function setTokenHeader(
  event: H3Event<EventHandlerRequest>,
  token: string,
) {
  setHeader(event, tokenHeader, token);
}

export async function createTokenIfNeeded(
  event: H3Event<EventHandlerRequest>,
): Promise<null | string> {
  if (!isTurnstileEnabled(event)) return null;
  const jwtSecret = setting(event, 'JWT_SECRET');
  if (!jwtSecret) return null;
  const token = event.headers.get(tokenHeader);
  if (!token) return null;
  if (!token.startsWith(turnstilePrefix)) return null;

  return await makeToken(getIp(event), jwtSecret);
}

export async function isAllowedToMakeRequest(
  event: H3Event<EventHandlerRequest>,
) {
  if (!isTurnstileEnabled(event)) return true;
  const jwtSecret = setting(event, 'JWT_SECRET');
  const turnstileSecret = setting(event, 'TURNSTILE_SECRET');

  const queryToken = getQuery(event).proxy_token;
  const token =
    event.headers.get(tokenHeader) ??
    (typeof queryToken === 'string' && queryToken.startsWith(jwtPrefix)
      ? queryToken
      : null);
  if (!token) return false;
  if (!jwtSecret || !turnstileSecret) return false;

  if (token.startsWith(jwtPrefix)) {
    const jwtToken = token.slice(jwtPrefix.length);
    let jwtPayload: { ip: string } | null = null;
    try {
      const jwtResult = await jwtVerify<{ ip: string }>(
        jwtToken,
        new TextEncoder().encode(jwtSecret),
        {
          algorithms: ['HS256'],
        },
      );
      jwtPayload = jwtResult.payload;
    } catch {}
    if (!jwtPayload) return false;
    if (getIp(event) !== jwtPayload.ip) return false;
    return true;
  }

  if (token.startsWith(turnstilePrefix)) {
    const turnstileToken = token.slice(turnstilePrefix.length);
    const formData = new FormData();
    formData.append('secret', turnstileSecret);
    formData.append('response', turnstileToken);
    formData.append('remoteip', getIp(event));

    const result = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        body: formData,
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      },
    );

    const outcome: { success: boolean } = await result.json();
    return result.ok && outcome.success === true;
  }

  return false;
}

export async function authorizeMedia(
  event: H3Event,
): Promise<string | undefined> {
  if (!(await isAllowedToMakeRequest(event))) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid or missing token',
    });
  }
  if (!isTurnstileEnabled(event)) {
    return;
  }
  const created = await createTokenIfNeeded(event);
  if (created) {
    setTokenHeader(event, created);
    return `${jwtPrefix}${created}`;
  }
  const queryToken = getQuery(event).proxy_token;
  return (
    event.headers.get(tokenHeader) ??
    (typeof queryToken === 'string' ? queryToken : undefined)
  );
}
