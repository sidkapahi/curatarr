# Librarian

A Discord bot for requesting audiobooks via Bookshelf (Readarr fork). Works like Requestrr but for audiobooks.

## Features

- `/request <title>` — Search and request an audiobook. Shows a dropdown of results with cover art, author, year and rating. Checks your library first so you don't request duplicates.
- `/library <query>` — Search your existing Bookshelf library
- `/status` — View the current download queue
- `/pending` — Admin only: view and approve/deny pending requests
- `/logs` — Admin only: view recent bot logs
- Approval mode — optionally require admin approval before downloads trigger
- DMs requester when their request is approved or denied
- Full JSON logging of every action to `/config/librarian.log`

---

## Setup

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it `Librarian`
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token** click **Reset Token** and copy it → this is your `DISCORD_TOKEN`
5. Enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent
6. Go to **OAuth2 → General** and copy the **Client ID** → this is your `DISCORD_CLIENT_ID`

### 2. Invite the bot to your server

Go to **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`, `Read Message History`

Copy the generated URL and open it in your browser to add the bot to your server.

### 3. Get your Bookshelf API key

In Bookshelf web UI: **Settings → General → API Key** — copy it.

### 4. Get your Discord Server ID

In Discord: **Settings → Advanced → Enable Developer Mode**
Then right-click your server name → **Copy Server ID**

### 5. Install on Unraid

#### Option A — Community Apps (recommended)
Search for **Librarian** in the Unraid Community Apps store and install directly.

#### Option B — Docker Compose
```bash
# Copy files to your server
mkdir -p /mnt/user/appdata/librarian-src
# Upload bot.js, package.json, Dockerfile, docker-compose.yml

# Build the image
cd /mnt/user/appdata/librarian-src
docker build -t librarian:latest .

# Edit docker-compose.yml with your values then run
docker compose up -d
```

#### Option C — Unraid Docker UI (after building image)
- **Repository:** `librarian:latest`
- **Network:** your Docker network
- **Volume:** `/mnt/user/appdata/librarian` → `/config`
- Add all environment variables listed below

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Your bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Your application's client ID |
| `BOOKSHELF_URL` | ✅ | URL to your Bookshelf instance e.g. `http://bookshelf:8787` |
| `BOOKSHELF_API_KEY` | ✅ | Bookshelf API key from Settings → General |
| `DISCORD_GUILD_ID` | Recommended | Your Discord server ID — makes command registration instant |
| `REQUEST_CHANNEL_ID` | Optional | Restrict bot to one channel |
| `ADMIN_ROLE_ID` | Optional | Role ID for admins (defaults to server Administrator permission) |
| `REQUIRE_APPROVAL` | Optional | Set to `true` to require admin approval before downloads |
| `LOG_FILE` | Optional | Log file path, defaults to `/config/librarian.log` |

---

## How it works

### For users
1. Type `/request The Martian` in Discord
2. Bot searches Bookshelf and shows a dropdown of results with cover art
3. Select your book
4. If approval is off: book is immediately added and download triggered
5. If approval is on: request goes to admin queue, you get a DM when approved/denied

### For admins
- `/pending` shows all requests waiting for approval with Approve/Deny buttons
- `/logs` shows the last 20 log entries
- `/status` shows the current download queue

---

## Logs

All actions are logged to `/config/librarian.log` in JSON format:

```json
{"timestamp":"2026-04-07T19:00:00.000Z","level":"INFO","message":"Request command","data":{"user":"Sid#1234","query":"The Martian"}}
{"timestamp":"2026-04-07T19:00:01.000Z","level":"INFO","message":"Book added successfully","data":{"title":"The Martian","id":42}}
```

---

