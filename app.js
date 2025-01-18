/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const session = require('express-session');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000; // Listen on port 3000

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Use session middleware to maintain persistent sessions
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Homepage with Proxy Form
app.get('/', (req, res) => {
    res.render('index');
});

// Proxy Endpoint
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const protocol = req.query.protocol || 'http://';

    if (!targetUrl) {
        return res.status(400).send('Missing url parameter.');
    }

    // Decode the target URL
    let fullUrl;
    try {
        fullUrl = decodeURIComponent(targetUrl);
    } catch (err) {
        return res.status(400).send('Invalid URL encoding.');
    }

    // Prepend protocol if not present
    if (!/^https?:\/\//i.test(fullUrl)) {
        fullUrl = protocol + fullUrl;
    }

    try {
        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // Set viewport size if needed
        // await page.setViewport({ width: 1280, height: 800 });

        // Set user agent and headers from the client request
        await page.setUserAgent(req.headers['user-agent'] || 'Mozilla/5.0');

        // Set cookies from session
        if (req.session.cookies) {
            await page.setCookie(...req.session.cookies);
        }

        // Intercept requests to handle resource loading
        await page.setRequestInterception(true);
        page.on('request', interceptedRequest => {
            // Allow all requests to proceed
            interceptedRequest.continue();
        });

        // Navigate to the target URL
        await page.goto(fullUrl, {
            waitUntil: 'networkidle0',
            timeout: 60000 // Adjust timeout as needed
        });

        // Get cookies and save them to the session
        const cookies = await page.cookies();
        req.session.cookies = cookies;

        // Get the page content
        let content = await page.content();

        // Close the browser
        await browser.close();

        // Rewrite URLs in the content
        content = rewriteContent(content, fullUrl);

        // Remove Content-Security-Policy header
        res.removeHeader('Content-Security-Policy');

        // Send the modified content to the client
        res.send(content);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('An error occurred while processing your request.');
    }
});

// Function to rewrite content
function rewriteContent(htmlContent, baseUrl) {
    const $ = cheerio.load(htmlContent);

    function rewriteUrl(url) {
        try {
            const absoluteUrl = new URL(url, baseUrl);
            const encodedUrl = encodeURIComponent(absoluteUrl.href);
            return `/proxy?url=${encodedUrl}`;
        } catch (e) {
            return url;
        }
    }

    // List of attributes to rewrite
    const attributesToRewrite = ['href', 'src', 'action', 'data-href', 'data-src', 'data-url'];

    attributesToRewrite.forEach(attr => {
        $(`[${attr}]`).each((i, elem) => {
            const value = $(elem).attr(attr);
            if (value && !value.startsWith('javascript:') && !value.startsWith('data:') && !value.startsWith('#')) {
                $(elem).attr(attr, rewriteUrl(value));
            }
        });
    });

    // Rewrite CSS URLs in style tags and attributes
    $('style').each((i, elem) => {
        let cssContent = $(elem).html();
        cssContent = cssContent.replace(/url\(['"]?([^'"\)]+)['"]?\)/g, (match, url) => {
            return `url('${rewriteUrl(url)}')`;
        });
        $(elem).html(cssContent);
    });

    $('[style]').each((i, elem) => {
        let styleContent = $(elem).attr('style');
        styleContent = styleContent.replace(/url\(['"]?([^'"\)]+)['"]?\)/g, (match, url) => {
            return `url('${rewriteUrl(url)}')`;
        });
        $(elem).attr('style', styleContent);
    });

    // Rewrite form actions
    $('form').each((i, elem) => {
        const action = $(elem).attr('action');
        if (!action || action.trim() === '') {
            $(elem).attr('action', `/proxy?url=${encodeURIComponent(baseUrl)}`);
        } else {
            $(elem).attr('action', rewriteUrl(action));
        }
    });

    return $.html();
}

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});