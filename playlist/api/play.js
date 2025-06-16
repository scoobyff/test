// api/play.js
export default async function handler(req, res) {
  // Get the channel ID from query parameter
  const channelId = req.query.id;

  if (!channelId) {
    return res.status(400).send('Channel ID is required. Use: /api/play?id=1373');
  }

  // Get the data token from environment variable (Vercel secret)
  const dataToken = process.env.DATA_TOKEN;
  if (!dataToken) {
    return res.status(500).send('DATA_TOKEN environment variable is not set');
  }

  try {
    // Fetch M3U playlist
    const response = await fetch(dataToken, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    if (!response.ok) {
      return res.status(500).send('Failed to fetch M3U playlist');
    }

    const m3uContent = await response.text();

    // Parse M3U content
    const lines = m3uContent.split('\n');
    const channels = {};
    let currentChannel = null;

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine.startsWith('#EXTINF:')) {
        // Extract channel info with regex
        const matches = trimmedLine.match(/tvg-id="([^"]*)".*?group-title="([^"]*)".*?tvg-logo="([^"]*)".*?,(.*)$/);
        
        currentChannel = {
          id: matches?.[1] || '',
          name: matches?.[4] || '',
          group: matches?.[2] || '',
          logo: matches?.[3] || '',
          props: [],
          vlc_opts: [],
          http: {}
        };
      } else if (trimmedLine.startsWith('#KODIPROP:') && currentChannel) {
        currentChannel.props.push(trimmedLine.substring(10));
      } else if (trimmedLine.startsWith('#EXTVLCOPT:') && currentChannel) {
        currentChannel.vlc_opts.push(trimmedLine.substring(11));
      } else if (trimmedLine.startsWith('#EXTHTTP:') && currentChannel) {
        try {
          currentChannel.http = JSON.parse(trimmedLine.substring(9));
        } catch (e) {
          currentChannel.http = {};
        }
      } else if (trimmedLine.startsWith('http') && currentChannel) {
        currentChannel.url = trimmedLine;
        channels[currentChannel.id] = currentChannel;
        currentChannel = null;
      }
    }

    // Find the requested channel
    if (!channels[channelId]) {
      return res.status(404).send(`Channel with ID '${channelId}' not found in playlist`);
    }

    const selectedChannel = channels[channelId];
    const streamUrl = selectedChannel.url;
    const channelName = selectedChannel.name;

    // Extract clearkey
    let clearkey_id = '';
    let clearkey_value = '';
    for (const prop of selectedChannel.props) {
      if (prop.startsWith('inputstream.adaptive.license_key=')) {
        const keys = prop.substring(33).split(':');
        if (keys.length === 2) {
          clearkey_id = keys[0];
          clearkey_value = keys[1];
          break;
        }
      }
    }

    // Extract user agent
    let userAgent = '';
    for (const opt of selectedChannel.vlc_opts) {
      if (opt.startsWith('http-user-agent=')) {
        userAgent = opt.substring(16);
        break;
      }
    }

    // Extract cookie and token
    const cookie = selectedChannel.http.cookie || '';
    let authToken = '';
    if (cookie) {
      const matches = cookie.match(/__hdnea__=([^;]*)/);
      if (matches) {
        authToken = matches[1];
      }
    }

    // Clean the stream URL
    const cleanUrl = streamUrl.replace(/[?&](__hdnea__|xxx)=[^&]*/g, '');

    // Generate HTML response
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${channelName.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c])}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.6.0/shaka-player.ui.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.6.0/controls.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      background: #000;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .shaka-video-container {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    video {
      width: 100%;
      height: 100%;
      background: #000;
      object-fit: contain;
    }
  </style>
</head>
<body>

<div class="shaka-video-container" data-shaka-player>
  <video autoplay muted playsinline preload="metadata"></video>
</div>

<script>
document.addEventListener('DOMContentLoaded', async () => {
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    console.error('Browser not supported');
    return;
  }

  const video = document.querySelector('video');
  const player = new shaka.Player();
  
  await player.attach(video);

  const container = document.querySelector('.shaka-video-container');
  const ui = new shaka.ui.Overlay(player, container, video);
  ui.getControls();

  // Player configuration
  player.configure({
    ${clearkey_id && clearkey_value ? `
    drm: {
      clearKeys: {
        "${clearkey_id}": "${clearkey_value}"
      }
    },` : ''}
    streaming: {
      bufferingGoal: 30,
      rebufferingGoal: 5,
      bufferBehind: 30,
      retryParameters: {
        timeout: 15000,
        maxAttempts: 3,
        baseDelay: 500,
        backoffFactor: 1.5
      },
      segmentRequestTimeout: 10000,
      useNativeHlsOnSafari: true
    },
    manifest: {
      retryParameters: {
        timeout: 10000,
        maxAttempts: 2
      }
    }
  });

  // Request filter
  player.getNetworkingEngine().registerRequestFilter((type, request) => {
    request.headers['Referer'] = 'https://www.jiotv.com/';
    
    ${userAgent ? `request.headers['User-Agent'] = "${userAgent.replace(/[\\'"]/g, '\\$&')}";` : ''}
    
    ${cookie ? `request.headers['Cookie'] = "${cookie.replace(/[\\'"]/g, '\\$&')}";` : ''}
    
    // Add token to manifest and segment URLs
    if ((type === shaka.net.NetworkingEngine.RequestType.MANIFEST ||
         type === shaka.net.NetworkingEngine.RequestType.SEGMENT) && 
        request.uris[0].indexOf('__hdnea__=') === -1) {
      ${authToken ? `
      const separator = request.uris[0].includes('?') ? '&' : '?';
      request.uris[0] += separator + '__hdnea__=${authToken.replace(/[\\'"]/g, '\\$&')}';` : ''}
    }
  });

  // Error handling
  player.addEventListener('error', (event) => {
    console.error('Shaka Player Error:', event.detail);
  });

  // Auto fullscreen on play
  video.addEventListener('play', () => {
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    }
  }, { once: true });

  // Load stream
  try {
    await player.load("${cleanUrl.replace(/[\\'"]/g, '\\$&')}");
  } catch (error) {
    console.error('Load error:', error);
  }
});
</script>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal server error');
  }
}