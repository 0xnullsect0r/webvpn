import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import fetch from 'cross-fetch';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;
let adBlocker = null;
// Initialize ad blocker
FiltersEngine.fromPrebuiltAdsAndTracking(fetch).then((engine) => {
    adBlocker = engine;
    console.log('Ad blocker initialized');
});
app.use(cors());
app.use(express.json());
// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('URL is required');
    }
    // Ad blocking check
    if (adBlocker) {
        const { match } = adBlocker.match(Request.fromRawDetails({
            url: targetUrl,
        }));
        if (match) {
            console.log(`Blocked ad/tracker: ${targetUrl}`);
            return res.status(204).end();
        }
    }
    try {
        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const contentType = response.headers['content-type'];
        if (contentType && contentType.includes('text/html')) {
            const htmlContent = Buffer.from(response.data).toString();
            const dom = new JSDOM(htmlContent);
            const doc = dom.window.document;
            // Add a script to intercept link clicks and form submissions and dynamic requests
            const script = doc.createElement('script');
            script.textContent = `
                (function() {
                    const proxyUrl = window.location.origin + '/proxy?url=';
                    
                    const rewrite = (url) => {
                        if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith(window.location.origin)) return url;
                        try {
                            const absoluteUrl = new URL(url, "${targetUrl}").href;
                            return '/proxy?url=' + encodeURIComponent(absoluteUrl);
                        } catch (e) {
                            return url;
                        }
                    };

                    // Intercept Fetch
                    const originalFetch = window.fetch;
                    window.fetch = function(input, init) {
                        if (typeof input === 'string') {
                            input = rewrite(input);
                        } else if (input instanceof Request) {
                            const newRequest = new Request(rewrite(input.url), input);
                            input = newRequest;
                        }
                        return originalFetch.apply(this, [input, init]);
                    };

                    // Intercept XHR
                    const originalOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, ...args) {
                        return originalOpen.apply(this, [method, rewrite(url), ...args]);
                    };

                    // Intercept Link Clicks
                    document.addEventListener('click', e => {
                        const a = e.target.closest('a');
                        if (a && a.href) {
                            const url = a.getAttribute('href');
                            if (url && !url.startsWith('#') && !url.startsWith('javascript:')) {
                                e.preventDefault();
                                window.location.href = rewrite(a.href);
                            }
                        }
                    }, true);

                    // Intercept Form Submissions
                    document.addEventListener('submit', e => {
                        const form = e.target;
                        if (form.action) {
                            // This is tricky for POST, but we can try to rewrite the action
                            form.action = rewrite(form.action);
                        }
                    }, true);
                })();
            `;
            doc.head.insertBefore(script, doc.head.firstChild);
            // Add CSP to prevent direct connections
            const meta = doc.createElement('meta');
            meta.setAttribute('http-equiv', 'Content-Security-Policy');
            // We allow 'self' for all, and 'unsafe-inline'/'unsafe-eval' because many sites need them.
            // connect-src 'self' is the key to preventing direct XHR/fetch to other domains.
            meta.setAttribute('content', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'self'; media-src 'self' blob:;");
            doc.head.insertBefore(meta, doc.head.firstChild);
            const rewriteUrl = (attr, element) => {
                const value = element.getAttribute(attr);
                if (value && !value.startsWith('data:') && !value.startsWith('javascript:')) {
                    try {
                        const absoluteUrl = new URL(value, targetUrl).href;
                        element.setAttribute(attr, `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                    }
                    catch (e) {
                        // Ignore invalid URLs
                    }
                }
            };
            doc.querySelectorAll('a').forEach(el => rewriteUrl('href', el));
            doc.querySelectorAll('img').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('link').forEach(el => rewriteUrl('href', el));
            doc.querySelectorAll('script').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('form').forEach(el => rewriteUrl('action', el));
            doc.querySelectorAll('source').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('video').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('audio').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('iframe').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('embed').forEach(el => rewriteUrl('src', el));
            doc.querySelectorAll('object').forEach(el => rewriteUrl('data', el));
            doc.querySelectorAll('track').forEach(el => rewriteUrl('src', el));
            // Rewrite srcset attributes
            doc.querySelectorAll('[srcset]').forEach(el => {
                const srcset = el.getAttribute('srcset');
                if (srcset) {
                    const newSrcset = srcset.split(',').map(part => {
                        const [url, size] = part.trim().split(/\s+/);
                        if (url) {
                            try {
                                const absoluteUrl = new URL(url, targetUrl).href;
                                return `/proxy?url=${encodeURIComponent(absoluteUrl)}${size ? ' ' + size : ''}`;
                            }
                            catch (e) {
                                return part;
                            }
                        }
                        return part;
                    }).join(', ');
                    el.setAttribute('srcset', newSrcset);
                }
            });
            // Apply cosmetic filters (hide ad elements)
            if (adBlocker) {
                const cosmeticFilters = adBlocker.getCosmeticsFilters(Request.fromRawDetails({ url: targetUrl }));
                if (cosmeticFilters && cosmeticFilters.styles) {
                    const style = doc.createElement('style');
                    style.textContent = cosmeticFilters.styles;
                    doc.head.appendChild(style);
                }
            }
            res.send(dom.serialize());
        }
        else if (contentType && (contentType.includes('text/css') || contentType.includes('javascript'))) {
            let content = Buffer.from(response.data).toString();
            if (contentType.includes('text/css')) {
                content = content.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
                    try {
                        if (p1.startsWith('data:'))
                            return match;
                        const absoluteUrl = new URL(p1, targetUrl).href;
                        return `url(/proxy?url=${encodeURIComponent(absoluteUrl)})`;
                    }
                    catch (e) {
                        return match;
                    }
                });
            }
            res.setHeader('Content-Type', contentType);
            res.send(content);
        }
        else {
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.send(response.data);
        }
    }
    catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send(`Error fetching URL: ${error.message}`);
    }
});
// Fallback to index.html for SPA routing
app.get(/^(?!\/proxy).*$/, (req, res) => {
    console.log(`Fallback for path: ${req.path}`);
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Proxy server running on http://0.0.0.0:${PORT}`);
});
