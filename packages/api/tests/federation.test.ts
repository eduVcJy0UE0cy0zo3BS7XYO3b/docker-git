import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  clearFederationState,
  createFollowSubscription,
  ingestFederationInbox,
  listFederationIssues,
  listFollowSubscriptions
} from "../src/services/federation.js"

describe("federation service", () => {
  it.effect("ingests ForgeFed Offer with Ticket payload", () =>
    Effect.gen(function*(_) {
      clearFederationState()

      const result = yield* _(
        ingestFederationInbox({
          "@context": [
            "https://www.w3.org/ns/activitystreams",
            "https://forgefed.org/ns"
          ],
          id: "https://tracker.example/offers/42",
          type: "Offer",
          target: "https://tracker.example/issues",
          object: {
            type: "Ticket",
            id: "https://tracker.example/issues/42",
            attributedTo: "https://origin.example/users/alice",
            summary: "Need reproducible CI parity",
            content: "Implement API behavior matching CLI."
          }
        })
      )

      expect(result.kind).toBe("issue.offer")
      if (result.kind === "issue.offer") {
        expect(result.issue.issueId).toBe("https://tracker.example/issues/42")
        expect(result.issue.status).toBe("offered")
      }

      const issues = listFederationIssues()
      expect(issues).toHaveLength(1)
      expect(issues[0]?.tracker).toBe("https://tracker.example/issues")
    }))

  it.effect("creates follow subscription and resolves it via Accept activity", () =>
    Effect.gen(function*(_) {
      clearFederationState()

      const created = yield* _(
        createFollowSubscription({
          actor: "https://dev.example/users/bot",
          object: "https://tracker.example/issues/followers",
          capability: "https://tracker.example/caps/follow",
          to: ["https://www.w3.org/ns/activitystreams#Public"]
        })
      )

      expect(created.subscription.status).toBe("pending")
      expect(created.activity.type).toBe("Follow")

      const accepted = yield* _(
        ingestFederationInbox({
          type: "Accept",
          actor: "https://tracker.example/system",
          object: created.activity.id
        })
      )

      expect(accepted.kind).toBe("follow.accept")
      if (accepted.kind === "follow.accept") {
        expect(accepted.subscription.status).toBe("accepted")
      }

      const follows = listFollowSubscriptions()
      expect(follows).toHaveLength(1)
      expect(follows[0]?.status).toBe("accepted")
    }))

  it.effect("rejects duplicate pending follow subscription", () =>
    Effect.gen(function*(_) {
      clearFederationState()

      const request = {
        actor: "https://dev.example/users/bot",
        object: "https://tracker.example/issues/followers"
      } as const

      yield* _(createFollowSubscription(request))

      const duplicateError = yield* _(
        createFollowSubscription(request).pipe(Effect.flip)
      )

      expect(duplicateError._tag).toBe("ApiConflictError")
    }))
})
