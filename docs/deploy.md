# Deploying

The service is the MatrixRTC token service of the calls of Twake Chat. The
client finds it in the client well-known and calls `POST /sfu/get` on it
directly, with an OpenID token of its homeserver. The service checks the
token and the membership with the homeserver, then asks Meet for the LiveKit
token, in the Meet room of the Matrix room.

```mermaid
sequenceDiagram
    participant C as Twake Chat
    participant V as Visio side service
    participant S as Synapse
    participant L as LDAP
    participant M as Meet
    C->>V: POST /sfu/get {room, openid_token, device_id}
    V->>S: openid/userinfo (who the token stands for)
    V->>S: is_joined, power levels, display name (as_token)
    V->>L: email and Twake instance of the user
    V->>M: Meet room of the Matrix room (created once), then its livekit-token
    V-->>C: {url, jwt}
```

The service refuses, before it asks Meet:

- a user of another homeserver (403 `M_FORBIDDEN`);
- an OpenID token the homeserver rejects (401 `M_UNKNOWN_TOKEN`);
- a user who is not joined to the room (403 `M_FORBIDDEN`);
- a user without a single email in the directory (403 `M_FORBIDDEN`).

Meet refusing to act for the user (domain not allowed, no account) answers 403
`M_FORBIDDEN`. A failure of the homeserver, the directory, Postgres or Meet
answers 502, and so does a request still pending after 14 seconds (Twake Chat
gives up after 15). Moderators of the room (power level 50 or more, or a
creator from room version 12) join as `administrator` of the Meet room, the
others as `member`. The LiveKit identity is `@user:server:device`.

## Image

`ghcr.io/linagora/twake-chat-visio-side-service`, tagged `latest` from `main`
and `X.Y.Z` from each release tag `vX.Y.Z`. Node 24; it runs as uid 1000 and
works on a read-only root filesystem, and listens on port 8080. It logs JSON
lines (pino): one per refused token and per failure.

## Routes

- `POST /sfu/get`: public, reached by browsers of any origin (CORS `*`; the
  credentials are in the body). Expose it over HTTPS. It has no rate limit of
  its own: set one at the ingress if needed.
- Liveness: `GET /health/live`.
- Readiness: `GET /health/ready`, 503 while Postgres does not answer within
  2 seconds.

## Environment

All required unless a default is given.

- `AS_TOKEN`: the `as_token` of the registration.
- `MATRIX_HOMESERVER_URL`: a listener of Synapse with the `client` resource and
  the `federation` or `openid` one (for `/_matrix/federation/v1/openid/userinfo`),
  for example `http://synapse:8008`.
- `MATRIX_SERVER_NAME`: the server name of the homeserver, whose users only
  are served.
- `DATABASE_URL`: the Postgres database, for example
  `postgres://visio:secret@postgresql:5432/visio`.
- `MEET_URL`: Meet, for example `https://meet.example.com`.
- `MEET_CLIENT_ID`, `MEET_CLIENT_SECRET`: the application of the service in
  Meet.
- `MEET_SERVICE_ACCOUNT_EMAIL`: the owner of the Meet rooms of the calls.
- `LDAP_URL`, `LDAP_BASE`: the directory, and where its users are.
- `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`: a bind that may read `mail`,
  `twakeWorkspaceUrl` and `workspaceUrl`, anonymous when unset. The password
  is required with a DN.
- `LDAP_UID_ATTRIBUTE`: the attribute that holds the Matrix localpart, `uid`
  by default.
- `HTTP_HOST`, `HTTP_PORT`: `0.0.0.0` and 8080 by default.
- `LOG_LEVEL`: `info` by default.

Each request to Synapse or Meet gives up after 5 seconds, and so does each step
with the directory (connection, bind, search). The token request as a whole
answers within 14 seconds.

## Well-known

The client well-known (`/.well-known/matrix/client`) names the service under
two keys, with the same URL:

- `livekit_base_url`: the one Twake Chat reads (the Flutter client reads only
  this one, the React client reads both);
- `livekit_service_url`: the one of the MatrixRTC clients of Element.

```json
{
  "org.matrix.msc4143.rtc_foci": [
    {
      "type": "livekit",
      "livekit_base_url": "https://visio.example.com",
      "livekit_service_url": "https://visio.example.com"
    }
  ]
}
```

## Meet

- The external API on (`EXTERNAL_API_ENABLED`, `APPLICATION_ENABLED`), with
  the `livekit-token/` route of the rooms
  ([linto-ai/meet#6](https://github.com/linto-ai/meet/pull/6)).
- An application with the scopes `rooms:create` and `rooms:livekit_token`.
  When it has allowed domains, they must hold the domain of every user and of
  the service account.
- `APPLICATION_ALLOW_USER_CREATION`, so that a user who never signed in to
  Meet gets an account from their email.
- The route of linto-ai/meet#6 at `e1502eb9` ignores `twake_instance`. Until
  Meet stores it, Meet knows no Drive for a user who never signed in to it,
  so their recordings and transcripts are not delivered there.
- Meet hands the LiveKit tokens of a room to the application that created it
  only. Changing `MEET_CLIENT_ID` makes each Matrix room get a new Meet room at
  its next call.

## LDAP

One entry per Matrix user, found under `LDAP_BASE` by
`LDAP_UID_ATTRIBUTE=<localpart>`, with a single `mail`. `twakeWorkspaceUrl`
(or the older `workspaceUrl`) goes to Meet as `twake_instance` when present.

## Postgres

A database of its own. The service creates its single table, `call_rooms`
(the Meet room of each Matrix room), at startup, so its user needs the right
to create tables. It exits when the database cannot be reached at startup.
Several replicas can share the database.

## Synapse

Synapse 1.160 or later. Copy
[`registration.example.yaml`](../registration.example.yaml), fill in the
`as_token` and any secret as `hs_token`, and list the file in
`app_service_config_files`. Then, in `homeserver.yaml`:

```yaml
experimental_features:
  msc4502_enabled: true # is_joined for application services
```

- Synapse reads the registration at startup only: restart it after any
  change.
- The registration lets the `as_token` act as any local user (the `users`
  namespace is `@.*`). Keep it as secret as an admin token.
