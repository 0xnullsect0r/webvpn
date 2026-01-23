import { useState, useRef } from 'react'
import './App.css'

function App() {
  const [url, setUrl] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const handleGo = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!url) return
    
    let targetUrl = url
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl
    }
    
    const proxiedUrl = `/proxy?url=${encodeURIComponent(targetUrl)}`
    setCurrentUrl(proxiedUrl)
  }

  const handleIframeLoad = () => {
    try {
        const iframeWindow = iframeRef.current?.contentWindow;
        if (iframeWindow) {
            const innerUrl = iframeWindow.location.href;
            const urlObj = new URL(innerUrl);
            const originalUrl = urlObj.searchParams.get('url');
            if (originalUrl && originalUrl !== url) {
                setUrl(originalUrl);
            }
        }
    } catch (e) {
        // Cross-origin error (should not happen if proxied to same origin)
    }
  }

  return (
    <div className="browser-container">
      <header className="browser-header">
        <form onSubmit={handleGo} className="address-bar-form">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter URL (e.g., example.com)"
            className="address-bar"
          />
          <button type="submit" className="go-button">Go</button>
        </form>
      </header>
      <main className="browser-content">
        {currentUrl ? (
          <iframe
            ref={iframeRef}
            src={currentUrl}
            className="browser-iframe"
            onLoad={handleIframeLoad}
            title="Web VPN Browser"
          />
        ) : (
          <div className="welcome-screen">
            <h1>Web VPN Browser</h1>
            <p>Enter a URL above to start browsing privately.</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
