import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';
import { FiltersEngine, Request as AdRequest } from '@ghostery/adblocker';
import fetch from 'cross-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

let adBlocker: FiltersEngine | null = null;

// Initialize ad blocker
FiltersEngine.fromPrebuiltAdsAndTracking(fetch).then((engine) => {
    adBlocker = engine;
    console.log('Ad blocker initialized');
});

// Store cookies per session (simplified: globally for now, but in a real app should be per user)
const cookieJar: Record<string, string> = {};

app.use(cors());
app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'dist')));

app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url as string;

    if (!targetUrl) {
        return res.status(400).send('URL is required');
    }

    // Ad blocking check
    if (adBlocker) {
        const { match } = adBlocker.match(AdRequest.fromRawDetails({
            url: targetUrl,
        }));
        if (match) {
            console.log(`Blocked ad/tracker: ${targetUrl}`);
            return res.status(204).end();
        }
    }

    try {
        const urlObj = new URL(targetUrl);
        const domain = urlObj.hostname;

        // Construct headers for the target request
        const headers: any = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': req.headers['accept'] || '*/*',
            'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
            'Referer': req.headers['referer'] ? (req.headers['referer'] as string).split('/proxy?url=')[1] || targetUrl : targetUrl,
        };

        if (cookieJar[domain]) {
            headers['Cookie'] = cookieJar[domain];
        }

        const response = await axios({
            method: req.method,
            url: targetUrl,
            data: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
            headers: headers,
            responseType: 'arraybuffer',
            maxRedirects: 0, // Handle redirects manually to rewrite them
            validateStatus: (status) => status >= 200 && status < 600
        });

        // Store received cookies
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
            const currentCookies = cookieJar[domain] || '';
            const newCookies = setCookie.map(c => c.split(';')[0]).join('; ');
            cookieJar[domain] = currentCookies ? `${currentCookies}; ${newCookies}` : newCookies;
        }

        // Handle redirects
        if (response.status >= 300 && response.status < 400 && response.headers['location']) {
            const redirectUrl = new URL(response.headers['location'], targetUrl).href;
            return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
        }

        // Strip headers that prevent iframing
        const headersToStrip = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'frame-options'];
        headersToStrip.forEach(header => {
            delete response.headers[header];
        });

        const contentType = (response.headers['content-type'] as string) || '';

        // Ad blocking check for sub-resources
        if (adBlocker) {
            const { match } = adBlocker.match(AdRequest.fromRawDetails({
                url: targetUrl,
                type: contentType.includes('image') ? 'image' : (contentType.includes('javascript') ? 'script' : (contentType.includes('css') ? 'stylesheet' : 'other'))
            }));
            if (match) {
                console.log(`Blocked sub-resource: ${targetUrl}`);
                return res.status(204).end();
            }
        }

        if (contentType.includes('text/html')) {
            const htmlContent = Buffer.from(response.data).toString();
            const dom = new JSDOM(htmlContent);
            const doc = dom.window.document;

            // Inject a <base> tag
            const base = doc.createElement('base');
            base.href = targetUrl;
            doc.head.insertBefore(base, doc.head.firstChild);

            // Basic rewriting
            const rewriteUrl = (attr: string, element: Element) => {
                const value = element.getAttribute(attr);
                if (value && !value.startsWith('data:') && !value.startsWith('javascript:') && !value.startsWith('#')) {
                    try {
                        const absoluteUrl = new URL(value, targetUrl).href;
                        element.setAttribute(attr, `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                    } catch (e) {}
                }
            };

            doc.querySelectorAll('a').forEach(el => rewriteUrl('href', el));
            doc.querySelectorAll('area').forEach(el => rewriteUrl('href', el));
            doc.querySelectorAll('form').forEach(el => rewriteUrl('action', el));
            doc.querySelectorAll('img').forEach(el => {
                rewriteUrl('src', el);
                rewriteUrl('srcset', el);
            });
            doc.querySelectorAll('script').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('link').forEach(el => rewriteUrl('href', el));
            doc.querySelectorAll('iframe').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('video, audio').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('source').forEach(el => {
                rewriteUrl('src', el);
                rewriteUrl('srcset', el);
            });
            doc.querySelectorAll('embed').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('object').forEach(el => rewriteUrl('data', el));
            doc.querySelectorAll('track').forEach(el => rewriteUrl('src', el));

            // Rewrite inline styles
            doc.querySelectorAll('[style]').forEach(el => {
                const style = el.getAttribute('style');
                if (style) {
                    const rewrittenStyle = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
                        try {
                            if (p1.startsWith('data:')) return match;
                            const absoluteUrl = new URL(p1, targetUrl).href;
                            return `url(/proxy?url=${encodeURIComponent(absoluteUrl)})`;
                        } catch (e) {
                            return match;
                        }
                    });
                    el.setAttribute('style', rewrittenStyle);
                }
            });

            // Inject CSP to prevent any direct traffic
            const csp = doc.createElement('meta');
            csp.setAttribute('http-equiv', 'Content-Security-Policy');
            csp.setAttribute('content', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data:; media-src 'self' data:; connect-src 'self';");
            doc.head.insertBefore(csp, doc.head.firstChild);

            // Inject script to help with dynamic requests and ensure SW is active
            const script = doc.createElement('script');
            script.textContent = `
                (function() {
                    // Try to ensure Service Worker is active for this client
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.register('/sw.js').then(reg => {
                            if (reg.active) reg.active.postMessage({type: 'CLAIM_CLIENTS'});
                        });
                    }

                    // Monkey-patch fetch and XHR as a fallback
                    const originalFetch = window.fetch;
                    window.fetch = function(input, init) {
                        if (typeof input === 'string' && !input.startsWith('/') && !input.startsWith(window.location.origin)) {
                            input = '/proxy?url=' + encodeURIComponent(new URL(input, '${targetUrl}').href);
                        }
                        return originalFetch.call(this, input, init);
                    };

                    const originalOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url) {
                        if (typeof url === 'string' && !url.startsWith('/') && !url.startsWith(window.location.origin)) {
                            url = '/proxy?url=' + encodeURIComponent(new URL(url, '${targetUrl}').href);
                        }
                        return originalOpen.apply(this, arguments);
                    };

                    // Intercept link clicks and form submissions for dynamically added elements
                    document.addEventListener('click', function(e) {
                        let target = e.target;
                        while (target && target.tagName !== 'A') target = target.parentElement;
                        if (target && target.href && !target.href.startsWith(window.location.origin)) {
                             // This is handled by the browser if we already rewrote the href, 
                             // but for dynamically added ones that missed rewriting:
                             if (!target.href.includes('/proxy?url=')) {
                                 target.href = '/proxy?url=' + encodeURIComponent(new URL(target.getAttribute('href'), '${targetUrl}').href);
                             }
                        }
                    }, true);

                    // MutationObserver to rewrite dynamically added elements
                    const observer = new MutationObserver(mutations => {
                        mutations.forEach(mutation => {
                            mutation.addedNodes.forEach(node => {
                                if (node.nodeType === 1) { // Element
                                    const el = node;
                                    const tags = ['a', 'img', 'script', 'link', 'iframe', 'video', 'audio', 'source', 'form'];
                                    const attrs = ['href', 'src', 'action', 'srcset'];
                                    
                                    const rewrite = (element) => {
                                        attrs.forEach(attr => {
                                            if (element.hasAttribute(attr)) {
                                                const val = element.getAttribute(attr);
                                                if (val && !val.startsWith('/') && !val.startsWith('http') && !val.startsWith('data:')) {
                                                     // relative URL
                                                     element.setAttribute(attr, '/proxy?url=' + encodeURIComponent(new URL(val, '${targetUrl}').href));
                                                } else if (val && (val.startsWith('http') && !val.startsWith(window.location.origin))) {
                                                     element.setAttribute(attr, '/proxy?url=' + encodeURIComponent(val));
                                                }
                                            }
                                        });
                                    };

                                    if (tags.includes(el.tagName.toLowerCase())) rewrite(el);
                                    el.querySelectorAll(tags.join(',')).forEach(rewrite);
                                }
                            });
                        });
                    });
                    observer.observe(document.documentElement, { childList: true, subtree: true });
                })();
            `;
            doc.head.insertBefore(script, doc.head.firstChild);

            // Apply cosmetic filters
            if (adBlocker) {
                const cosmeticFilters = adBlocker.getCosmeticsFilters(AdRequest.fromRawDetails({ url: targetUrl }));
                if (cosmeticFilters && cosmeticFilters.styles) {
                    const style = doc.createElement('style');
                    style.textContent = cosmeticFilters.styles;
                    doc.head.appendChild(style);
                }
            }

            res.setHeader('Content-Type', 'text/html');
            res.send(dom.serialize());
        } else if (contentType.includes('text/css')) {
            let content = Buffer.from(response.data).toString();
            content = content.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
                try {
                    if (p1.startsWith('data:')) return match;
                    const absoluteUrl = new URL(p1, targetUrl).href;
                    return `url(/proxy?url=${encodeURIComponent(absoluteUrl)})`;
                } catch (e) {
                    return match;
                }
            });
            res.setHeader('Content-Type', contentType);
            res.send(content);
        } else {
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.send(response.data);
        }

    } catch (error: any) {
        console.error('Proxy error:', error.message);
        res.status(500).send(`Error fetching URL: ${error.message}`);
    }
});

// Fallback to index.html for SPA routing
app.get(/^(?!\/proxy).*$/, (req: any, res: any) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Proxy server running on http://0.0.0.0:${PORT}`);
});
