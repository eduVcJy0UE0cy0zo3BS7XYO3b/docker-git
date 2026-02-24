# @effect-template/api

Clean-slate v1 HTTP API for docker-git orchestration.

## UI wrapper

После запуска API открой:

- `http://localhost:3334/`

Это встроенная фронт-обвязка для ручного тестирования endpoint-ов (проекты, агенты, логи, SSE).

## Run

```bash
pnpm --filter ./packages/api build
pnpm --filter ./packages/api start
```

Env:

- `DOCKER_GIT_API_PORT` (default: `3334`)
- `DOCKER_GIT_PROJECTS_ROOT` (default: `~/.docker-git`)
- `DOCKER_GIT_API_LOG_LEVEL` (default: `info`)
- `DOCKER_GIT_FEDERATION_PUBLIC_ORIGIN` (optional public ActivityPub domain, e.g. `https://social.my-domain.tld`)
- `DOCKER_GIT_FEDERATION_ACTOR` (default: `docker-git`)

## Endpoints

- `GET /health`
- `POST /federation/inbox` (ForgeFed `Ticket` / `Offer(Ticket)`, ActivityPub `Accept` / `Reject`)
- `GET /federation/issues`
- `GET /federation/actor` (ActivityPub `Person`)
- `GET /federation/outbox`
- `GET /federation/followers`
- `GET /federation/following`
- `GET /federation/liked`
- `POST /federation/follows` (create ActivityPub `Follow` activity for task-feed subscription)
- `GET /federation/follows`
- `GET /projects`
- `GET /projects/:projectId`
- `POST /projects`
- `DELETE /projects/:projectId`
- `POST /projects/:projectId/up`
- `POST /projects/:projectId/down`
- `POST /projects/:projectId/recreate`
- `GET /projects/:projectId/ps`
- `GET /projects/:projectId/logs`
- `GET /projects/:projectId/events` (SSE)
- `POST /projects/:projectId/agents`
- `GET /projects/:projectId/agents`
- `GET /projects/:projectId/agents/:agentId`
- `GET /projects/:projectId/agents/:agentId/attach`
- `POST /projects/:projectId/agents/:agentId/stop`
- `GET /projects/:projectId/agents/:agentId/logs`

## Example

```bash
curl -s http://localhost:3334/projects
curl -s -X POST http://localhost:3334/projects/<projectId>/up
curl -s -N http://localhost:3334/projects/<projectId>/events

curl -s http://localhost:3334/federation/actor

curl -s -X POST http://localhost:3334/federation/follows \
  -H 'content-type: application/json' \
  -d '{"domain":"social.my-domain.tld","object":"https://social.my-domain.tld/issues/followers"}'

curl -s -X POST http://localhost:3334/federation/inbox \
  -H 'content-type: application/json' \
  -d '{"@context":["https://www.w3.org/ns/activitystreams","https://forgefed.org/ns"],"id":"https://social.my-domain.tld/offers/42","type":"Offer","target":"https://social.my-domain.tld/issues","object":{"type":"Ticket","id":"https://social.my-domain.tld/issues/42","attributedTo":"https://origin.my-domain.tld/users/alice","summary":"Title","content":"Body"}}'
```
