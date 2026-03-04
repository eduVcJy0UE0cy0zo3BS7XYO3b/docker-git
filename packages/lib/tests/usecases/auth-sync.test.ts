import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ensureCodexConfigFile,
  migrateLegacyOrchLayout,
  syncGithubAuthKeys
} from "../../src/usecases/auth-sync.js"

const withTempDir = <A, E, R>(
  use: (tempDir: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function*(_) {
      const fs = yield* _(FileSystem.FileSystem)
      const tempDir = yield* _(
        fs.makeTempDirectoryScoped({
          prefix: "docker-git-auth-sync-"
        })
      )
      return yield* _(use(tempDir))
    })
  )

describe("syncGithubAuthKeys", () => {
  it("updates github token keys from source and preserves non-auth target keys", () => {
    const source = [
      "# docker-git env",
      "# KEY=value",
      "GITHUB_TOKEN=token_new",
      "GITHUB_TOKEN__WORK=token_work",
      "SOME_SOURCE_ONLY=value",
      ""
    ].join("\n")
    const target = [
      "# docker-git env",
      "# KEY=value",
      "GITHUB_TOKEN=token_old",
      "GH_TOKEN=legacy_old",
      "CUSTOM_FLAG=1",
      ""
    ].join("\n")

    const next = syncGithubAuthKeys(source, target)

    expect(next).toContain("GITHUB_TOKEN=token_new")
    expect(next).toContain("GITHUB_TOKEN__WORK=token_work")
    expect(next).not.toContain("GH_TOKEN=legacy_old")
    expect(next).toContain("CUSTOM_FLAG=1")
  })

  it("keeps target unchanged when source has no github token keys", () => {
    const source = [
      "# docker-git env",
      "# KEY=value",
      "UNRELATED=1",
      ""
    ].join("\n")
    const target = [
      "# docker-git env",
      "# KEY=value",
      "GITHUB_TOKEN=token_old",
      "CUSTOM_FLAG=1",
      ""
    ].join("\n")

    const next = syncGithubAuthKeys(source, target)

    expect(next).toBe(target)
  })

  it.effect("ignores permission-denied codex config rewrites", () =>
    withTempDir((root) =>
      Effect.gen(function*(_) {
        const fs = yield* _(FileSystem.FileSystem)
        const path = yield* _(Path.Path)
        const codexDir = path.join(root, ".orch", "auth", "codex")
        const configPath = path.join(codexDir, "config.toml")
        const readOnlyConfig = [
          "# docker-git codex config",
          "model = \"gpt-5\"",
          ""
        ].join("\n")

        yield* _(fs.makeDirectory(codexDir, { recursive: true }))
        yield* _(fs.writeFileString(configPath, readOnlyConfig))
        yield* _(fs.chmod(configPath, 0o400))

        yield* _(ensureCodexConfigFile(root, ".orch/auth/codex"))

        const next = yield* _(fs.readFileString(configPath))
        expect(next).toBe(readOnlyConfig)
      })
    ).pipe(Effect.provide(NodeContext.layer)))

  it.effect("migrates legacy claude auth directory into docker-git root", () =>
    withTempDir((root) =>
      Effect.gen(function*(_) {
        const fs = yield* _(FileSystem.FileSystem)
        const path = yield* _(Path.Path)
        const legacyClaudeDefault = path.join(root, ".orch", "auth", "claude", "default")
        const legacyTokenPath = path.join(legacyClaudeDefault, ".oauth-token")
        const expectedToken = "legacy-claude-token\n"

        yield* _(fs.makeDirectory(legacyClaudeDefault, { recursive: true }))
        yield* _(fs.writeFileString(legacyTokenPath, expectedToken))

        yield* _(
          migrateLegacyOrchLayout(
            root,
            ".docker-git/.orch/env/global.env",
            ".orch/env/project.env",
            ".docker-git/.orch/auth/codex",
            ".docker-git/.orch/auth/gh",
            ".docker-git/.orch/auth/claude"
          )
        )

        const migratedTokenPath = path.join(
          root,
          ".docker-git",
          ".orch",
          "auth",
          "claude",
          "default",
          ".oauth-token"
        )
        const migratedToken = yield* _(fs.readFileString(migratedTokenPath))
        expect(migratedToken).toBe(expectedToken)
      })
    ).pipe(Effect.provide(NodeContext.layer)))
})
