# Mesh Inbox API

Standalone API that reads the **mesh Redis** where continuum inboxes are stored. Same key layout as the mesh router (`queue:{continuumId}:{qos}`, `stats:{continuumId}`, `continuums:set`). Uses **MESH_REDIS_URL** (or REDIS_URL), not Canny Carrot Redis.

## Setup

```bash
npm install
```

Set env:

- **MESH_REDIS_URL** – same Redis URL as mesh router (continuum inboxes). Or **REDIS_URL** if this is the only Redis in this app.

## Run

```bash
npm run dev   # port 3002
# or
npm run build && npm start
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Redis status |
| GET | /api/v1/inbox/continuums | List continuum IDs |
| GET | /api/v1/inbox/:continuumId | Dequeue next message (Q0→Q1→Q2→Q3) |
| GET | /api/v1/inbox/:continuumId/depth | Queue depth per QoS (no dequeue) |
| GET | /api/v1/inbox/:continuumId/stats | Stats for continuum |

## Example

```bash
# List continuums
curl http://localhost:3002/api/v1/inbox/continuums

# Read next message for InboxTestReceiver (dequeue)
curl http://localhost:3002/api/v1/inbox/InboxTestReceiver

# Depth only
curl http://localhost:3002/api/v1/inbox/InboxTestReceiver/depth
```
