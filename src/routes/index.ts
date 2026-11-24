import {
  getProxyHeaders,
  getAfterResponseHeaders,
  getBlacklistedHeaders,
} from '@/utils/headers';
import {
  createTokenIfNeeded,
  isAllowedToMakeRequest,
  setTokenHeader,
} from '@/utils/turnstile';

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'Cache-Control': 'no-store',
  });
  // Handle preflight CORS requests
  if (isPreflightRequest(event)) {
    handleCors(event, {});
    // Ensure the response ends here for preflight
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  // Reject any other OPTIONS requests
  if (event.node.req.method === 'OPTIONS') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method Not Allowed',
    });
  }

  // Parse destination URL
  const destination = getQuery<{ destination?: string }>(event).destination;
  if (!destination) {
    return await sendJson({
      event,
      status: 200,
      data: {
        message: `Proxy is working as expected (v${
          useRuntimeConfig(event).version
        })`,
      },
    });
  }
  if (typeof destination !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Destination must be a URL string',
    });
  }

  // Check if allowed to make the request
  if (!(await isAllowedToMakeRequest(event))) {
    return await sendJson({
      event,
      status: 401,
      data: {
        error: 'Invalid or missing token',
      },
    });
  }

  // Read body and create token if needed
  const token = await createTokenIfNeeded(event);

  // Proxy the request
  try {
    return await specificProxyRequest(event, destination, {
      blacklistedHeaders: getBlacklistedHeaders(),
      fetchOptions: {
        redirect: 'follow',
        headers: getProxyHeaders(event.headers),
      },
      onResponse(outputEvent, response) {
        const headers = getAfterResponseHeaders(
          response.headers,
          outputEvent.context.proxyFinalUrl ?? response.url,
        );
        if (
          token ||
          event.headers.has('x-token') ||
          event.headers.has('x-cookie') ||
          event.headers.has('authorization') ||
          event.headers.has('cookie') ||
          response.headers.has('set-cookie') ||
          getQuery(event).proxy_token
        ) {
          headers['Cache-Control'] = 'private, no-store';
        }
        setResponseHeaders(outputEvent, headers);
        if (token) setTokenHeader(event, token);
      },
    });
  } catch (e) {
    throw e;
  }
});
