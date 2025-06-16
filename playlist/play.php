<?php
// Get the channel ID from URL parameter
$channelId = isset($_GET['id']) ? $_GET['id'] : null;

if (!$channelId) {
    die('Channel ID is required. Use: play.php?id=1373');
}

// Get the data token from environment variable (GitHub secret)
$dataToken = getenv('DATA_TOKEN');
if (!$dataToken) {
    die('DATA_TOKEN environment variable is not set');
}

// Fetch M3U playlist with timeout and user agent
$context = stream_context_create([
    'http' => [
        'timeout' => 10,
        'user_agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ]
]);

$m3uContent = file_get_contents($dataToken, false, $context);

if (!$m3uContent) {
    die('Failed to fetch M3U playlist');
}

// Parse M3U content efficiently
$lines = explode("\n", $m3uContent);
$channels = [];
$currentChannel = null;

foreach ($lines as $line) {
    $line = trim($line);
    
    if (strpos($line, '#EXTINF:') === 0) {
        // Extract channel info with single regex
        preg_match('/tvg-id="([^"]*)".*?group-title="([^"]*)".*?tvg-logo="([^"]*)".*?,(.*)$/', $line, $matches);
        
        $currentChannel = [
            'id' => $matches[1] ?? '',
            'name' => $matches[4] ?? '',
            'group' => $matches[2] ?? '',
            'logo' => $matches[3] ?? '',
            'props' => [],
            'vlc_opts' => [],
            'http' => []
        ];
    } elseif (strpos($line, '#KODIPROP:') === 0 && $currentChannel) {
        $currentChannel['props'][] = substr($line, 10);
    } elseif (strpos($line, '#EXTVLCOPT:') === 0 && $currentChannel) {
        $currentChannel['vlc_opts'][] = substr($line, 11);
    } elseif (strpos($line, '#EXTHTTP:') === 0 && $currentChannel) {
        $currentChannel['http'] = json_decode(substr($line, 9), true) ?: [];
    } elseif (strpos($line, 'http') === 0 && $currentChannel) {
        $currentChannel['url'] = $line;
        $channels[$currentChannel['id']] = $currentChannel;
        $currentChannel = null;
    }
}

// Find the requested channel
if (!isset($channels[$channelId])) {
    die("Channel with ID '$channelId' not found in playlist");
}

$selectedChannel = $channels[$channelId];
$streamUrl = $selectedChannel['url'];
$channelName = $selectedChannel['name'];

// Extract clearkey efficiently
$clearkey_id = $clearkey_value = '';
foreach ($selectedChannel['props'] as $prop) {
    if (strpos($prop, 'inputstream.adaptive.license_key=') === 0) {
        $keys = explode(':', substr($prop, 33));
        if (count($keys) === 2) {
            $clearkey_id = $keys[0];
            $clearkey_value = $keys[1];
            break;
        }
    }
}

// Extract user agent
$userAgent = '';
foreach ($selectedChannel['vlc_opts'] as $opt) {
    if (strpos($opt, 'http-user-agent=') === 0) {
        $userAgent = substr($opt, 16);
        break;
    }
}

// Extract cookie and token
$cookie = $selectedChannel['http']['cookie'] ?? '';
$authToken = '';
if ($cookie && preg_match('/__hdnea__=([^;]*)/', $cookie, $matches)) {
    $authToken = $matches[1];
}

// Clean the stream URL
$cleanUrl = preg_replace('/[?&](__hdnea__|xxx)=[^&]*/', '', $streamUrl);
?>
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title><?php echo htmlspecialchars($channelName); ?></title>
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

  // Optimized player configuration
  player.configure({
    <?php if ($clearkey_id && $clearkey_value): ?>
    drm: {
      clearKeys: {
        "<?php echo $clearkey_id; ?>": "<?php echo $clearkey_value; ?>"
      }
    },
    <?php endif; ?>
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

  // Optimized request filter
  player.getNetworkingEngine().registerRequestFilter((type, request) => {
    request.headers['Referer'] = 'https://www.jiotv.com/';
    
    <?php if ($userAgent): ?>
    request.headers['User-Agent'] = "<?php echo addslashes($userAgent); ?>";
    <?php endif; ?>
    
    <?php if ($cookie): ?>
    request.headers['Cookie'] = "<?php echo addslashes($cookie); ?>";
    <?php endif; ?>
    
    // Add token to manifest and segment URLs
    if ((type === shaka.net.NetworkingEngine.RequestType.MANIFEST ||
         type === shaka.net.NetworkingEngine.RequestType.SEGMENT) && 
        request.uris[0].indexOf('__hdnea__=') === -1) {
      <?php if ($authToken): ?>
      const separator = request.uris[0].includes('?') ? '&' : '?';
      request.uris[0] += separator + '__hdnea__=<?php echo addslashes($authToken); ?>';
      <?php endif; ?>
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
    await player.load("<?php echo addslashes($cleanUrl); ?>");
  } catch (error) {
    console.error('Load error:', error);
  }
});
</script>

</body>
</html>