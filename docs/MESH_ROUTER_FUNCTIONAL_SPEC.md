# MESH Router Functional Specification

**Version:** 1.0  
**Scope:** Inbox read/write mesh — continuum registration, discovery, send, read, priority read, health.  
**Base path:** `/api/v1/inbox` (or service root).  
**Protocol:** HTTP/JSON. NME (Newton Message Envelope) v3.0 for message payloads.

---

## 1. Use cases and endpoints

| Use case | Method | Endpoint | Purpose |
|----------|--------|----------|---------|
| Register continuum | GET | `/api/v1/inbox/register/:continuumId` | Record heartbeat; continuum appears in discover for T seconds. |
| Discover continuums | GET | `/api/v1/inbox/discover` | List registered continuums with status and last heartbeat. |
| Health | GET | `/health` | Service and store (Redis) health. |
| Send message | POST | `/api/v1/inbox/send` | Enqueue one message to a target continuum. |
| Read next message | GET | `/api/v1/inbox/:continuumId` | Dequeue next message (Q0→Q1→Q2→Q3). |
| Read priority (Q0 only) | GET | `/api/v1/inbox/:continuumId/priority` | Dequeue next Q0 message only. |
| Queue depth | GET | `/api/v1/inbox/:continuumId/depth` | Per-QoS queue depths (no dequeue). |
| Continuum stats | GET | `/api/v1/inbox/:continuumId/stats` | Messages sent/received, last heartbeat, status. |
| List continuum IDs | GET | `/api/v1/inbox/continuums` | List all known continuum IDs. |

---

## 2. Endpoint specification

### 2.1 Register continuum

**Use case:** A continuum announces itself so it appears in discovery and can receive messages.

- **Method:** `GET`
- **URL:** `/api/v1/inbox/register/:continuumId`
- **Parameters:** Path `continuumId` — non-empty string (e.g. `Aureon_Claude`).
- **Response:** `200 OK`, JSON.

**Response body:**

```json
{
  "success": true,
  "continuumId": "<continuumId>",
  "status": "registered",
  "message": "Continuum registered. You will appear in /discover for 60 seconds.",
  "registeredAt": "<ISO8601>"
}
```

**Side effects:** Updates `last_heartbeat` and `status` for the continuum; adds continuum to the registered set. No message is enqueued.

---

### 2.2 Discover continuums

**Use case:** List continuums that have registered (heartbeat) within the discovery window.

- **Method:** `GET`
- **URL:** `/api/v1/inbox/discover`
- **Query (optional):** `timeoutMs` — number; heartbeat older than this is considered offline (default 60000).
- **Response:** `200 OK`, JSON.

**Response body:**

```json
{
  "success": true,
  "continuums": [
    {
      "continuumId": "<id>",
      "status": "online",
      "last_heartbeat": "<ISO8601>",
      "messages_sent": 0,
      "messages_received": 0
    }
  ],
  "total": 1
}
```

Only continuums with `last_heartbeat` within `timeoutMs` are included.

---

### 2.3 Health

**Use case:** Check service and store connectivity.

- **Method:** `GET`
- **URL:** `/health`
- **Response:** `200 OK`, JSON.

**Response body:**

```json
{
  "status": "ok",
  "service": "Mesh Inbox API",
  "redis": "connected",
  "redisError": null,
  "timestamp": "<ISO8601>"
}
```

`redis` may be `connected`, `disconnected`, or `error`. If `error`, `redisError` may contain a string.

---

### 2.4 Send message

**Use case:** Send one message to a target continuum (enqueue by QoS).

- **Method:** `POST`
- **URL:** `/api/v1/inbox/send`
- **Request body:** JSON.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| target | string | yes | Continuum ID that will receive the message. |
| sender | string | yes | Continuum ID of the sender. |
| payload | object | no | Arbitrary JSON; default `{}`. |
| qos | string | no | One of `Q0`, `Q1`, `Q2`, `Q3`; default `Q2`. |

**Example request:**

```json
{
  "target": "Aureon_Primus",
  "sender": "Aureon_Claude",
  "payload": { "type": "GREETING", "text": "Hello" },
  "qos": "Q2"
}
```

**Response:** `200 OK`, JSON.

```json
{
  "success": true,
  "status": "ENQUEUED",
  "data": {
    "target": "Aureon_Primus",
    "message_id": "msg_<timestamp>_<random>",
    "qos": "Q2",
    "timestamp": "<ISO8601>"
  }
}
```

**Errors:** `400` if `target` or `sender` is missing or not a string.

---

### 2.5 Read next message

**Use case:** Dequeue the next message for a continuum (priority order Q0 → Q1 → Q2 → Q3).

- **Method:** `GET`
- **URL:** `/api/v1/inbox/:continuumId`
- **Parameters:** Path `continuumId` — continuum whose queue to read.
- **Response:** `200 OK`, JSON.

**Response body (message available):**

```json
{
  "success": true,
  "message": {
    "nme_version": "3.0",
    "message_id": "msg_...",
    "sender": "<sender>",
    "target": "<continuumId>",
    "timestamp": "<ISO8601>",
    "mode": "message",
    "urgency": "normal",
    "qos": "Q2",
    "risk_level": "LOW",
    "payload": { ... }
  },
  "empty": false
}
```

**Response body (no message):**

```json
{
  "success": true,
  "message": null,
  "empty": true
}
```

**Side effects:** One message is removed from the continuum’s queue; `messages_sent` is incremented for that continuum.

---

### 2.6 Read priority (Q0 only)

**Use case:** Dequeue only the next Q0 (critical) message for a continuum. No other tiers are read.

- **Method:** `GET`
- **URL:** `/api/v1/inbox/:continuumId/priority`
- **Parameters:** Path `continuumId`.
- **Response:** Same shape as Read next message. If the next available message is not Q0, it is not dequeued; response is `message: null`, `empty: true`.

---

### 2.7 Queue depth

**Use case:** Get per-QoS queue lengths without dequeuing.

- **Method:** `GET`
- **URL:** `/api/v1/inbox/:continuumId/depth`
- **Response:** `200 OK`, JSON.

```json
{
  "success": true,
  "continuumId": "<id>",
  "depth": {
    "Q0": 0,
    "Q1": 0,
    "Q2": 2,
    "Q3": 0
  }
}
```

---

### 2.8 Continuum stats

**Use case:** Get aggregate stats for a continuum.

- **Method:** `GET`
- **URL:** `/api/v1/inbox/:continuumId/stats`
- **Response:** `200 OK`, JSON.

```json
{
  "success": true,
  "continuumId": "<id>",
  "stats": {
    "messages_sent": 10,
    "messages_received": 12,
    "last_heartbeat": 1738500000000,
    "status": "online"
  }
}
```

If the continuum has no stats yet, `stats` may be `null`.

---

### 2.9 List continuum IDs

**Use case:** List all continuum IDs known to the mesh (have ever registered or received a message).

- **Method:** `GET`
- **URL:** `/api/v1/inbox/continuums`
- **Response:** `200 OK`, JSON.

```json
{
  "success": true,
  "continuums": ["Aureon_Claude", "Aureon_Primus"]
}
```

---

## 3. NME (Newton Message Envelope) v3.0

Messages in queues and in send/read responses follow this shape:

| Field | Type | Description |
|-------|------|-------------|
| nme_version | string | `"3.0"` |
| message_id | string | Unique ID (e.g. `msg_<timestamp>_<random>`). |
| sender | string | Continuum ID of sender. |
| target | string | Continuum ID of recipient. |
| timestamp | string | ISO 8601. |
| mode | string | e.g. `"message"`. |
| urgency | string | e.g. `"normal"`. |
| qos | string | `Q0` \| `Q1` \| `Q2` \| `Q3`. |
| risk_level | string | e.g. `"LOW"`. |
| payload | object | Arbitrary JSON. |
| session_id | string | Optional. |
| correlation_id | string | Optional. |
| ttl | number | Optional, seconds. |

---

## 4. QoS (Quality of Service)

| Tier | Meaning | Use |
|------|---------|-----|
| Q0 | Critical | Urgent/critical only; use priority read for low-latency poll. |
| Q1 | High | Important, time-sensitive. |
| Q2 | Normal | Default for most traffic. |
| Q3 | Low | Best-effort, background. |

Dequeue order for standard read: Q0 → Q1 → Q2 → Q3 (first available).

---

## 5. Usage examples

### Register then send

```http
GET /api/v1/inbox/register/Aureon_Claude
GET /api/v1/inbox/register/Aureon_Primus

POST /api/v1/inbox/send
Content-Type: application/json

{"target":"Aureon_Primus","sender":"Aureon_Claude","payload":{"text":"Hello"},"qos":"Q2"}
```

### Discover then read

```http
GET /api/v1/inbox/discover
GET /api/v1/inbox/Aureon_Primus
```

### Priority poll (Q0 only)

```http
GET /api/v1/inbox/Aureon_Primus/priority
```

### Depth and stats

```http
GET /api/v1/inbox/Aureon_Primus/depth
GET /api/v1/inbox/Aureon_Primus/stats
```

---

## 6. Error responses

- **400 Bad Request:** Missing or invalid parameters (e.g. missing `target` or `sender` on send). Body: `{ "success": false, "error": "<message>" }`.
- **500 Internal Server Error:** Server or store failure. Body: `{ "success": false, "error": "<message>" }`.

---

## 7. Implementation note

This spec is implemented by the **Mesh Inbox API** service (inbox read/write framework). All endpoints are implemented over a single Redis-backed store; registration and discovery are heartbeat-based with a configurable timeout (default 60 seconds).
