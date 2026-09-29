# MT · Echoes of Silence

## Run the game

Install Node.js 20 or newer, then run:

```sh
npm install
npm start
```

Open `http://localhost:3000`. The same Node process serves the game page, `/health`, and the `/ws` multiplayer connection.

## Play online with friends

Deploy this folder to a Node.js host that supports persistent WebSocket connections. Set its `PORT` environment variable if required and run `npm start`. Use the public HTTPS URL; the game automatically connects using secure WebSockets (`wss://`). The room creator shares the five-character code. Each person enters a display name before creating or joining; a room allows up to five players.

The server keeps rooms in memory, so rooms close when the host disconnects or the server restarts. This prototype does not use accounts or persistent scores.
