'use strict';

/**
 * OpenWii — relay server.
 *
 * Local:
 *   HTTPS with a self-signed certificate so phone motion sensors work.
 *
 * Production (Render):
 *   Render terminates HTTPS, so Node runs plain HTTP internally.
 *   The public Render URL is used for phone pairing.
 */

const { exec } = require('child_process');
const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { ensureCert, localAddresses } = require('./scripts/gen-cert');

const PORT = Number(process.env.PORT) || 8443;
const FORCE_HTTP = process.env.HTTP === '1';

// Render provides this environment variable.
// Locally it will be undefined.
const IS_RENDER = process.env.RENDER === 'true';

// Public URL supplied by Render, e.g.
// https://openwii.onrender.com
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;

const GAMES_DIR = path.join(__dirname, 'games');

const app = express();

// -----------------------------------------------------------------------------
// Static files
// -----------------------------------------------------------------------------

const NO_CACHE = {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
};

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    ...NO_CACHE
  })
);

app.use(
  '/games',
  express.static(GAMES_DIR, {
    extensions: ['html'],
    ...NO_CACHE
  })
);

app.use(
  '/core',
  express.static(path.join(__dirname, 'core'), NO_CACHE)
);

app.use(
  '/vendor/three',
  express.static(
    path.join(__dirname, 'node_modules', 'three', 'build')
  )
);

app.use(
  '/audio',
  express.static(path.join(__dirname, 'audio'), {
    fallthrough: true
  })
);

// -----------------------------------------------------------------------------
// Game discovery
// -----------------------------------------------------------------------------

function listGames() {
  let entries;

  try {
    entries = fs.readdirSync(GAMES_DIR, {
      withFileTypes: true
    });
  } catch {
    return [];
  }

  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(
          path.join(GAMES_DIR, e.name, 'index.html')
        )
    )
    .map((e) => {
      const meta = {
        title: e.name,
        tagline: '',
        emoji: '🎮'
      };

      try {
        Object.assign(
          meta,
          JSON.parse(
            fs.readFileSync(
              path.join(GAMES_DIR, e.name, 'game.json'),
              'utf8'
            )
          )
        );
      } catch {
        // game.json is optional
      }

      return {
        slug: e.name,
        url: `/games/${e.name}/`,
        ...meta
      };
    })
    .filter((g) => !g.hidden)
    .sort(
      (a, b) =>
        (a.order ?? 99) - (b.order ?? 99) ||
        a.title.localeCompare(b.title)
    );
}

app.get('/api/games', (_req, res) => {
  res.json(listGames());
});

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

const BOOT_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

app.get('/api/session', (_req, res) => {
  res.json({ bootId: BOOT_ID });
});

// -----------------------------------------------------------------------------
// Server mode
// -----------------------------------------------------------------------------

/*
 * LOCAL:
 *   HTTPS + self-signed certificate.
 *
 * RENDER:
 *   Plain HTTP because Render terminates HTTPS before forwarding
 *   requests to this process.
 *
 * HTTP=1:
 *   Explicit local HTTP mode.
 */
const USE_TLS = !FORCE_HTTP && !IS_RENDER;

const tls = USE_TLS ? ensureCert() : null;

const server = tls
  ? https.createServer(tls, app)
  : http.createServer(app);

const scheme = USE_TLS ? 'https' : 'http';

// -----------------------------------------------------------------------------
// Controller URL
// -----------------------------------------------------------------------------

let controllerUrl;

if (IS_RENDER && PUBLIC_URL) {
  // Public Render URL.
  controllerUrl = `${PUBLIC_URL.replace(/\/$/, '')}/controller`;
} else {
  // Local LAN URL.
  const lanIp = localAddresses()[0] || 'localhost';
  controllerUrl = `${scheme}://${lanIp}:${PORT}/controller`;
}

// -----------------------------------------------------------------------------
// Pairing QR
// -----------------------------------------------------------------------------

app.get('/api/pairing', async (_req, res) => {
  try {
    const qr = await QRCode.toDataURL(controllerUrl, {
      margin: 1,
      width: 320,
      color: {
        dark: '#0b0e14',
        light: '#ffffff'
      }
    });

    res.json({
      url: controllerUrl,
      qr
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// Socket.IO
// -----------------------------------------------------------------------------

const io = new Server(server, {
  transports: ['websocket', 'polling'],

  pingInterval: 10000,
  pingTimeout: 5000,

  cors: {
    origin: '*'
  }
});

/** socket.id → 'game' | 'controller' */
const roles = new Map();

function countOf(role) {
  let n = 0;

  for (const r of roles.values()) {
    if (r === role) n += 1;
  }

  return n;
}

// -----------------------------------------------------------------------------
// Player slots
// -----------------------------------------------------------------------------

const MAX_PLAYERS = 4;
const slots = new Array(MAX_PLAYERS).fill(null);

function assignSlot(socketId) {
  const free = slots.indexOf(null);

  if (free === -1) {
    return -1;
  }

  slots[free] = socketId;

  return free;
}

function releaseSlot(socketId) {
  const i = slots.indexOf(socketId);

  if (i !== -1) {
    slots[i] = null;
  }
}

const slotOf = (socketId) => slots.indexOf(socketId);

function broadcastPresence() {
  io.emit('presence', {
    game: countOf('game'),
    controller: countOf('controller'),
    slots: slots.map((id, i) => ({
      slot: i,
      occupied: id !== null
    }))
  });
}

// -----------------------------------------------------------------------------
// Socket events
// -----------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('register', (role) => {
    if (role !== 'game' && role !== 'controller') {
      return;
    }

    roles.set(socket.id, role);
    socket.join(role);

    if (role === 'controller') {
      const slot = assignSlot(socket.id);

      if (slot === -1) {
        socket.emit('slot-denied', {
          reason: 'all player slots full',
          max: MAX_PLAYERS
        });

        console.log(
          `[io] controller rejected — ${MAX_PLAYERS} slots full (${socket.id})`
        );

        return;
      }

      socket.emit('slot', {
        slot
      });

      console.log(
        `[io] controller connected as player ${
          slot + 1
        } (${socket.id})`
      );
    } else {
      console.log(
        `[io] game connected (${socket.id})`
      );
    }

    broadcastPresence();
  });

  // ---------------------------------------------------------------------------
  // Latency probe
  // ---------------------------------------------------------------------------

  socket.on('ping-probe', (data) => {
    socket.to('controller').emit('ping-probe', data);
  });

  socket.on('pong-probe', (data) => {
    socket.to('game').emit('pong-probe', data);
  });

  // ---------------------------------------------------------------------------
  // Phone → PC orientation
  // ---------------------------------------------------------------------------

  socket.on('orientation', (data) => {
    socket
      .to('game')
      .emit('orientation', {
        ...data,
        slot: slotOf(socket.id)
      });
  });

  // ---------------------------------------------------------------------------
  // Phone → PC motion
  // ---------------------------------------------------------------------------

  socket.on('motion', (data) => {
    socket
      .to('game')
      .emit('motion', {
        ...data,
        slot: slotOf(socket.id)
      });
  });

  // ---------------------------------------------------------------------------
  // Phone → PC commands
  // ---------------------------------------------------------------------------

  socket.on('command', (data) => {
    socket
      .to('game')
      .emit('command', {
        ...data,
        slot: slotOf(socket.id)
      });
  });

  // ---------------------------------------------------------------------------
  // PC → phone feedback
  // ---------------------------------------------------------------------------

  socket.on('feedback', (data) => {
    if (
      typeof data.slot === 'number' &&
      slots[data.slot]
    ) {
      io
        .to(slots[data.slot])
        .emit('feedback', data);
    } else {
      socket
        .to('controller')
        .emit('feedback', data);
    }
  });

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  socket.on('disconnect', () => {
    const role = roles.get(socket.id);

    roles.delete(socket.id);
    releaseSlot(socket.id);

    if (role) {
      console.log(
        `[io] ${role} disconnected (${socket.id})`
      );
    }

    broadcastPresence();
  });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(52);

  console.log(`\n${line}`);
  console.log(
    '  🕹  OpenWii — your phone is the remote'
  );
  console.log(line);

  if (IS_RENDER) {
    console.log(
      `  Production     ${PUBLIC_URL || 'Render URL not detected'}`
    );

    console.log(
      `  Phone remote   ${controllerUrl}`
    );
  } else {
    console.log(
      `  Launcher       ${scheme}://localhost:${PORT}/`
    );

    console.log(
      `  Phone remote   ${controllerUrl}`
    );
  }

  const games = listGames();

  console.log(
    `\n  ${games.length} game${
      games.length === 1 ? '' : 's'
    }:`
  );

  for (const g of games) {
    console.log(
      `    ${g.emoji}  ${g.title}  →  ${g.url}`
    );
  }

  if (IS_RENDER) {
    console.log(
      '\n  ☁  Running on Render.'
    );

    console.log(
      '     Render handles HTTPS; Socket.IO runs through the public service.'
    );
  } else if (!tls) {
    console.log(
      '\n  ⚠  Running plain HTTP. Phone sensors will NOT work off'
    );

    console.log(
      '     localhost — browsers gate the IMU behind a secure context.'
    );
  } else {
    console.log(
      '\n  ⚠  Self-signed cert: the phone will show a warning once.'
    );

    console.log(
      '     Tap Advanced → Proceed. Sensors need HTTPS to unlock.'
    );
  }

  // macOS local TV browser.
  if (
    tls &&
    process.platform === 'darwin' &&
    !process.env.NO_OPEN
  ) {
    exec(
      'open -na "Google Chrome" --args' +
        ' --user-data-dir="$HOME/.openwii-chrome"' +
        ' --no-first-run' +
        ' --no-default-browser-check' +
        ' --autoplay-policy=no-user-gesture-required' +
        ` --new-window https://localhost:${PORT}/`
    );

    console.log(
      '\n  📺 Opening the console in Chrome (autoplay enabled)…'
    );

    console.log(
      '     Skip with NO_OPEN=1 npm start.'
    );
  }

  console.log(`${line}\n`);
});