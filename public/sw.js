self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLAIM_CLIENTS') {
    self.clients.claim();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only intercept requests that are meant for the proxy or are subresources of a proxied page
  // We'll use a specific marker in the URL or check the referrer to decide.
  // For simplicity in this 'redo', we'll assume all requests from the iframe should be proxied
  // if they are not already going to our /proxy endpoint.
  
  if (url.origin === self.location.origin) {
    if (url.pathname === '/proxy') {
        // Already a proxy request, let it go through
        return;
    }
    // Static assets for the app itself
    if (url.pathname.startsWith('/src') || url.pathname.startsWith('/node_modules') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.startsWith('/assets') || url.pathname === '/vite.svg') {
        return;
    }
    // Don't intercept the root page or index.html
    if (url.pathname === '/' || url.pathname === '/index.html') {
        return;
    }
  }

  // If we are here, it's a request from the proxied page that we want to intercept.
  // We need to know what the 'current' target base URL is.
  // We can get this from the client's URL if it's currently showing a proxied page.
  
  event.respondWith(
    (async () => {
      const client = await self.clients.get(event.clientId);
      if (!client) return fetch(event.request);

      const clientUrl = new URL(client.url);
      const targetUrlParam = clientUrl.searchParams.get('url');
      if (!targetUrlParam) return fetch(event.request);

      try {
        const targetBase = new URL(targetUrlParam);
        const actualTargetUrl = new URL(event.request.url, targetBase).href;
        
        // Rewrite the request to go through our proxy
        const proxyUrl = `/proxy?url=${encodeURIComponent(actualTargetUrl)}`;
        
        // Clone the request to modify it
        const headers = new Headers(event.request.headers);
        
        const fetchOptions = {
          method: event.request.method,
          headers: headers,
          credentials: 'omit',
          mode: 'cors'
        };

        let body;
        if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
          body = await event.request.blob();
        }
        
        const response = await fetch(proxyUrl, { ...fetchOptions, body });
        
        // Strip security headers from the proxied response as well
        const newHeaders = new Headers(response.headers);
        const headersToStrip = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'frame-options', 'x-content-security-policy', 'x-webkit-csp'];
        headersToStrip.forEach(function(h) { newHeaders.delete(h); });

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (e) {
        return fetch(event.request);
      }
    })()
  );
});
