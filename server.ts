import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url as string;

    if (!targetUrl) {
        return res.status(400).send('URL is required');
    }

    try {
        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const contentType = response.headers['content-type'] as string;

        if (contentType && contentType.includes('text/html')) {
            const htmlContent = Buffer.from(response.data).toString();
            const dom = new JSDOM(htmlContent);
            const doc = dom.window.document;

            // Add a script to intercept link clicks and form submissions if they are not caught by our rewriting
            const script = doc.createElement('script');
            script.textContent = `
                document.addEventListener('click', e => {
                    const a = e.target.closest('a');
                    if (a && a.href) {
                        const url = new URL(a.href);
                        if (!url.searchParams.has('url') || !a.href.includes('/proxy')) {
                             // Intercept clicks on links that weren't rewritten for some reason
                        }
                    }
                });
            `;
            doc.head.appendChild(script);

            const rewriteUrl = (attr: string, element: Element) => {
                const value = element.getAttribute(attr);
                if (value && !value.startsWith('data:') && !value.startsWith('javascript:')) {
                    try {
                        const absoluteUrl = new URL(value, targetUrl).href;
                        element.setAttribute(attr, `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                    } catch (e) {
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

            res.send(dom.serialize());
        } else if (contentType && (contentType.includes('text/css') || contentType.includes('javascript'))) {
            let content = Buffer.from(response.data).toString();
            if (contentType.includes('text/css')) {
                content = content.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
                    try {
                        if (p1.startsWith('data:')) return match;
                        const absoluteUrl = new URL(p1, targetUrl).href;
                        return `url(/proxy?url=${encodeURIComponent(absoluteUrl)})`;
                    } catch (e) {
                        return match;
                    }
                });
            }
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
    console.log(`Fallback for path: ${req.path}`);
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Proxy server running on http://0.0.0.0:${PORT}`);
});
