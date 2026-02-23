import { Effect } from "effect"
import { randomUUID } from "node:crypto"

import type {
  ActivityPubFollowActivity,
  CreateFollowRequest,
  FederationInboxResult,
  FederationIssueRecord,
  FollowStatus,
  FollowSubscription,
  FollowSubscriptionCreated,
  ForgeFedTicket
} from "../api/contracts.js"
import { ApiBadRequestError, ApiConflictError, ApiNotFoundError } from "../api/errors.js"

type JsonRecord = { readonly [key: string]: unknown }

const issueStore: Map<string, FederationIssueRecord> = new Map()
const followStore: Map<string, FollowSubscription> = new Map()
const followByActivityId: Map<string, string> = new Map()
const followByActorObject: Map<string, string> = new Map()

const nowIso = (): string => new Date().toISOString()

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): JsonRecord | null =>
  isRecord(value) ? value : null

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null

const readOptionalString = (record: JsonRecord, key: string): string | undefined =>
  asNonEmptyString(record[key]) ?? undefined

const readRequiredString = (
  record: JsonRecord,
  key: string,
  label: string
): Effect.Effect<string, ApiBadRequestError> => {
  const value = asNonEmptyString(record[key])
  return value !== null
    ? Effect.succeed(value)
    : Effect.fail(
      new ApiBadRequestError({
        message: `${label} must include a non-empty "${key}" field.`
      })
    )
}

const readTypeTags = (record: JsonRecord): ReadonlyArray<string> => {
  const raw = record["type"]
  if (typeof raw === "string") {
    const value = raw.trim()
    return value.length > 0 ? [value] : []
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

const hasType = (record: JsonRecord, expected: string): boolean =>
  readTypeTags(record).includes(expected)

const readObjectRecord = (
  payload: JsonRecord,
  key: string,
  label: string
): Effect.Effect<JsonRecord, ApiBadRequestError> => {
  const objectRecord = asRecord(payload[key])
  return objectRecord !== null
    ? Effect.succeed(objectRecord)
    : Effect.fail(
      new ApiBadRequestError({
        message: `${label} must include an object "${key}" payload.`
      })
    )
}

const parseTicket = (
  payload: JsonRecord
): Effect.Effect<ForgeFedTicket, ApiBadRequestError> =>
  Effect.gen(function*(_) {
    if (!hasType(payload, "Ticket")) {
      return yield* _(
        Effect.fail(
          new ApiBadRequestError({
            message: "ForgeFed ticket payload must include type=\"Ticket\"."
          })
        )
      )
    }

    const attributedTo = yield* _(readRequiredString(payload, "attributedTo", "ForgeFed ticket"))
    const summary = yield* _(readRequiredString(payload, "summary", "ForgeFed ticket"))
    const content = yield* _(readRequiredString(payload, "content", "ForgeFed ticket"))
    const id = readOptionalString(payload, "id") ?? `urn:docker-git:forgefed:ticket:${randomUUID()}`

    return {
      id,
      attributedTo,
      summary,
      content,
      mediaType: readOptionalString(payload, "mediaType"),
      source: readOptionalString(payload, "source"),
      published: readOptionalString(payload, "published"),
      updated: readOptionalString(payload, "updated"),
      url: readOptionalString(payload, "url")
    }
  })

const upsertIssue = (issue: FederationIssueRecord): FederationIssueRecord => {
  issueStore.set(issue.issueId, issue)
  return issue
}

const followKey = (actor: string, object: string): string => `${actor}\u0000${object}`

const cleanToRecipients = (
  raw: ReadonlyArray<string> | undefined
): ReadonlyArray<string> =>
  (raw ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const lookupFollowByReference = (
  reference: string
): Effect.Effect<FollowSubscription, ApiNotFoundError> => {
  const byActivity = followByActivityId.get(reference)
  if (byActivity) {
    const stored = followStore.get(byActivity)
    if (stored) {
      return Effect.succeed(stored)
    }
  }

  const direct = followStore.get(reference)
  if (direct) {
    return Effect.succeed(direct)
  }

  return Effect.fail(
    new ApiNotFoundError({
      message: `Follow subscription not found for reference: ${reference}`
    })
  )
}

const updateFollowStatus = (
  subscription: FollowSubscription,
  status: FollowStatus
): FollowSubscription => {
  const updated: FollowSubscription = {
    ...subscription,
    status,
    updatedAt: nowIso()
  }
  followStore.set(updated.id, updated)
  followByActivityId.set(updated.activityId, updated.id)
  followByActorObject.set(followKey(updated.actor, updated.object), updated.id)
  return updated
}

const resolveFollowFromInbox = (
  payload: JsonRecord
): Effect.Effect<FollowSubscription, ApiBadRequestError | ApiNotFoundError> =>
  Effect.gen(function*(_) {
    const objectValue = payload["object"]

    if (typeof objectValue === "string" && objectValue.trim().length > 0) {
      return yield* _(lookupFollowByReference(objectValue.trim()))
    }

    const objectRecord = asRecord(objectValue)
    if (objectRecord === null) {
      return yield* _(
        Effect.fail(
          new ApiBadRequestError({
            message: "Accept/Reject payload must include object reference as string or Follow object."
          })
        )
      )
    }

    const explicitId = readOptionalString(objectRecord, "id")
    if (explicitId !== undefined) {
      return yield* _(lookupFollowByReference(explicitId))
    }

    if (!hasType(objectRecord, "Follow")) {
      return yield* _(
        Effect.fail(
          new ApiBadRequestError({
            message: "Accept/Reject payload object must include type=\"Follow\" when no id is provided."
          })
        )
      )
    }

    const actor = yield* _(readRequiredString(objectRecord, "actor", "Follow object reference"))
    const object = yield* _(readRequiredString(objectRecord, "object", "Follow object reference"))
    const indexed = followByActorObject.get(followKey(actor, object))
    if (!indexed) {
      return yield* _(
        Effect.fail(
          new ApiNotFoundError({
            message: `Follow subscription not found for actor=${actor} object=${object}`
          })
        )
      )
    }
    return yield* _(lookupFollowByReference(indexed))
  })

const ingestOfferTicket = (
  payload: JsonRecord
): Effect.Effect<FederationIssueRecord, ApiBadRequestError> =>
  Effect.gen(function*(_) {
    const objectPayload = yield* _(readObjectRecord(payload, "object", "ForgeFed offer"))
    if (!hasType(objectPayload, "Ticket")) {
      return yield* _(
        Effect.fail(
          new ApiBadRequestError({
            message: "ForgeFed offer currently supports object.type=\"Ticket\" only."
          })
        )
      )
    }

    const ticket = yield* _(parseTicket(objectPayload))
    const issueId = ticket.id
    const issue = upsertIssue({
      issueId,
      offerId: readOptionalString(payload, "id"),
      tracker: readOptionalString(payload, "target"),
      status: "offered",
      receivedAt: nowIso(),
      ticket
    })
    return issue
  })

const ingestDirectTicket = (
  payload: JsonRecord
): Effect.Effect<FederationIssueRecord, ApiBadRequestError> =>
  Effect.map(parseTicket(payload), (ticket) =>
    upsertIssue({
      issueId: ticket.id,
      status: "accepted",
      receivedAt: nowIso(),
      ticket
    }))

// CHANGE: support ForgeFed issue inputs and ActivityPub inbox transitions in API mode.
// WHY: Konrad requested ForgeFed Issue intake and Follow workflow support in PR discussion.
// QUOTE(ТЗ): "А сможешь на вход поддержать ... #issues" + "добавить поддержку follow"
// REF: pr-88-konrad-request
// SOURCE: n/a
// FORMAT THEOREM: ∀m: validInbox(m) → handled(m) ∈ {issue.offer, issue.ticket, follow.accept, follow.reject}
// PURITY: SHELL
// EFFECT: Effect<FederationInboxResult, ApiBadRequestError | ApiNotFoundError>
// INVARIANT: state transitions are deterministic for identical references
// COMPLEXITY: O(1)
export const ingestFederationInbox = (
  payload: unknown
): Effect.Effect<FederationInboxResult, ApiBadRequestError | ApiNotFoundError> =>
  Effect.gen(function*(_) {
    const record = asRecord(payload)
    if (record === null) {
      return yield* _(
        Effect.fail(
          new ApiBadRequestError({
            message: "Inbox payload must be a JSON object."
          })
        )
      )
    }

    if (hasType(record, "Offer")) {
      const issue = yield* _(ingestOfferTicket(record))
      return { kind: "issue.offer", issue }
    }

    if (hasType(record, "Ticket")) {
      const issue = yield* _(ingestDirectTicket(record))
      return { kind: "issue.ticket", issue }
    }

    if (hasType(record, "Accept") || hasType(record, "Reject")) {
      const subscription = yield* _(resolveFollowFromInbox(record))
      const status: FollowStatus = hasType(record, "Accept") ? "accepted" : "rejected"
      const updated = updateFollowStatus(subscription, status)
      return status === "accepted"
        ? { kind: "follow.accept", subscription: updated }
        : { kind: "follow.reject", subscription: updated }
    }

    return yield* _(
      Effect.fail(
        new ApiBadRequestError({
          message: "Unsupported inbox payload type. Expected Offer(Ticket), Ticket, Accept, or Reject."
        })
      )
    )
  })

// CHANGE: build outgoing ActivityPub Follow subscriptions for task feeds.
// WHY: requested to subscribe to issue/task distribution via ActivityPub Follow.
// QUOTE(ТЗ): "добавить поддержку follow, чтобы можно было подписатся на отдачу задач"
// REF: pr-88-konrad-request
// SOURCE: n/a
// FORMAT THEOREM: ∀r: valid(r) → ∃s: s.status = pending ∧ s.actor = r.actor ∧ s.object = r.object
// PURITY: SHELL
// EFFECT: Effect<FollowSubscriptionCreated, ApiBadRequestError | ApiConflictError>
// INVARIANT: non-rejected actor/object pairs are unique
// COMPLEXITY: O(1)
export const createFollowSubscription = (
  request: CreateFollowRequest
): Effect.Effect<FollowSubscriptionCreated, ApiBadRequestError | ApiConflictError> =>
  Effect.gen(function*(_) {
    const actor = request.actor.trim()
    if (actor.length === 0) {
      return yield* _(Effect.fail(new ApiBadRequestError({ message: "Follow actor must be non-empty." })))
    }

    const object = request.object.trim()
    if (object.length === 0) {
      return yield* _(Effect.fail(new ApiBadRequestError({ message: "Follow object must be non-empty." })))
    }

    const key = followKey(actor, object)
    const existingId = followByActorObject.get(key)
    if (existingId) {
      const existing = followStore.get(existingId)
      if (existing && existing.status !== "rejected") {
        return yield* _(
          Effect.fail(
            new ApiConflictError({
              message: `Follow subscription already exists for actor=${actor} object=${object}.`
            })
          )
        )
      }
    }

    const to = cleanToRecipients(request.to)
    const capability = request.capability?.trim()
    const inbox = request.inbox?.trim()
    const id = randomUUID()
    const activityId = `urn:docker-git:activity:follow:${id}`
    const createdAt = nowIso()

    const activity: ActivityPubFollowActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: activityId,
      type: "Follow",
      actor,
      object,
      ...(to.length === 0 ? {} : { to }),
      ...(capability && capability.length > 0 ? { capability } : {})
    }

    const subscription: FollowSubscription = {
      id,
      activityId,
      actor,
      object,
      inbox: inbox && inbox.length > 0 ? inbox : undefined,
      to,
      capability: capability && capability.length > 0 ? capability : undefined,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      activity
    }

    followStore.set(id, subscription)
    followByActivityId.set(activityId, id)
    followByActorObject.set(key, id)

    return { subscription, activity }
  })

export const listFederationIssues = (): ReadonlyArray<FederationIssueRecord> =>
  [...issueStore.values()].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))

export const listFollowSubscriptions = (): ReadonlyArray<FollowSubscription> =>
  [...followStore.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))

export const clearFederationState = (): void => {
  issueStore.clear()
  followStore.clear()
  followByActivityId.clear()
  followByActorObject.clear()
}
