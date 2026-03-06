import type { PlatformError } from "@effect/platform/Error"
import type * as FileSystem from "@effect/platform/FileSystem"
import type * as Path from "@effect/platform/Path"
import { Effect } from "effect"

import { copyCodexFile, copyDirIfEmpty } from "./auth-copy.js"
import {
  type AuthSyncSpec,
  defaultCodexConfig,
  hasClaudeCredentials,
  hasClaudeOauthAccount,
  isGithubTokenKey,
  type LegacyOrchPaths,
  parseJsonRecord,
  resolvePathFromBase,
  shouldCopyEnv,
  shouldRewriteDockerGitCodexConfig,
  skipCodexConfigPermissionDenied
} from "./auth-sync-helpers.js"
import { parseEnvEntries, removeEnvKey, upsertEnvKey } from "./env-file.js"
import { withFsPathContext } from "./runtime.js"

// CHANGE: synchronize GitHub auth keys between env files
// WHY: avoid stale per-project tokens that cause clone auth failures after token rotation
// QUOTE(ТЗ): n/a
// REF: user-request-2026-02-11-clone-invalid-token
// SOURCE: n/a
// FORMAT THEOREM: ∀k ∈ github_token_keys: source(k)=v → merged(k)=v
// PURITY: CORE
// INVARIANT: non-auth keys in target are preserved
// COMPLEXITY: O(n) where n = |env entries|
export const syncGithubAuthKeys = (sourceText: string, targetText: string): string => {
  const sourceTokenEntries = parseEnvEntries(sourceText).filter((entry) => isGithubTokenKey(entry.key))
  if (sourceTokenEntries.length === 0) {
    return targetText
  }

  const targetTokenKeys = parseEnvEntries(targetText)
    .filter((entry) => isGithubTokenKey(entry.key))
    .map((entry) => entry.key)

  let next = targetText
  for (const key of targetTokenKeys) {
    next = removeEnvKey(next, key)
  }
  for (const entry of sourceTokenEntries) {
    next = upsertEnvKey(next, entry.key, entry.value)
  }

  return next
}

const syncGithubTokenKeysInFile = (
  sourcePath: string,
  targetPath: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs }) =>
    Effect.gen(function*(_) {
      const sourceExists = yield* _(fs.exists(sourcePath))
      if (!sourceExists) {
        return
      }
      const targetExists = yield* _(fs.exists(targetPath))
      if (!targetExists) {
        return
      }
      const sourceInfo = yield* _(fs.stat(sourcePath))
      const targetInfo = yield* _(fs.stat(targetPath))
      if (sourceInfo.type !== "File" || targetInfo.type !== "File") {
        return
      }

      const sourceText = yield* _(fs.readFileString(sourcePath))
      const targetText = yield* _(fs.readFileString(targetPath))
      const mergedText = syncGithubAuthKeys(sourceText, targetText)
      if (mergedText !== targetText) {
        yield* _(fs.writeFileString(targetPath, mergedText))
        yield* _(Effect.log(`Synced GitHub auth keys from ${sourcePath} to ${targetPath}`))
      }
    })
  )

const copyFileIfNeeded = (
  sourcePath: string,
  targetPath: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs, path }) =>
    Effect.gen(function*(_) {
      const sourceExists = yield* _(fs.exists(sourcePath))
      if (!sourceExists) {
        return
      }
      const sourceInfo = yield* _(fs.stat(sourcePath))
      if (sourceInfo.type !== "File") {
        return
      }
      yield* _(fs.makeDirectory(path.dirname(targetPath), { recursive: true }))
      const targetExists = yield* _(fs.exists(targetPath))
      if (!targetExists) {
        yield* _(fs.copyFile(sourcePath, targetPath))
        yield* _(Effect.log(`Copied env file from ${sourcePath} to ${targetPath}`))
        return
      }
      const sourceText = yield* _(fs.readFileString(sourcePath))
      const targetText = yield* _(fs.readFileString(targetPath))
      if (shouldCopyEnv(sourceText, targetText) === "copy") {
        yield* _(fs.writeFileString(targetPath, sourceText))
        yield* _(Effect.log(`Synced env file from ${sourcePath} to ${targetPath}`))
      }
    })
  )

type ClaudeJsonSyncSpec = {
  readonly sourcePath: string
  readonly targetPath: string
  readonly hasRequiredData: (record: Parameters<typeof hasClaudeOauthAccount>[0]) => boolean
  readonly onWrite: (targetPath: string) => Effect.Effect<void, PlatformError>
  readonly seedLabel: string
  readonly updateLabel: string
}

const syncClaudeJsonFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spec: ClaudeJsonSyncSpec
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function*(_) {
    const sourceExists = yield* _(fs.exists(spec.sourcePath))
    if (!sourceExists) {
      return
    }

    const sourceInfo = yield* _(fs.stat(spec.sourcePath))
    if (sourceInfo.type !== "File") {
      return
    }

    const sourceText = yield* _(fs.readFileString(spec.sourcePath))
    const sourceJson = yield* _(parseJsonRecord(sourceText))
    if (!spec.hasRequiredData(sourceJson)) {
      return
    }

    const targetExists = yield* _(fs.exists(spec.targetPath))
    if (!targetExists) {
      yield* _(fs.makeDirectory(path.dirname(spec.targetPath), { recursive: true }))
      yield* _(fs.copyFile(spec.sourcePath, spec.targetPath))
      yield* _(spec.onWrite(spec.targetPath))
      yield* _(Effect.log(`Seeded ${spec.seedLabel} from ${spec.sourcePath} to ${spec.targetPath}`))
      return
    }

    const targetInfo = yield* _(fs.stat(spec.targetPath))
    if (targetInfo.type !== "File") {
      return
    }

    const targetText = yield* _(fs.readFileString(spec.targetPath), Effect.orElseSucceed(() => ""))
    const targetJson = yield* _(parseJsonRecord(targetText))
    if (!spec.hasRequiredData(targetJson)) {
      yield* _(fs.writeFileString(spec.targetPath, sourceText))
      yield* _(spec.onWrite(spec.targetPath))
      yield* _(Effect.log(`Updated ${spec.updateLabel} from ${spec.sourcePath} to ${spec.targetPath}`))
    }
  })

const syncClaudeHomeJson = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourcePath: string,
  targetPath: string
): Effect.Effect<void, PlatformError> =>
  syncClaudeJsonFile(fs, path, {
    sourcePath,
    targetPath,
    hasRequiredData: hasClaudeOauthAccount,
    onWrite: () => Effect.void,
    seedLabel: "Claude auth file",
    updateLabel: "Claude auth file"
  })

const syncClaudeCredentialsJson = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourcePath: string,
  targetPath: string
): Effect.Effect<void, PlatformError> =>
  syncClaudeJsonFile(fs, path, {
    sourcePath,
    targetPath,
    hasRequiredData: hasClaudeCredentials,
    onWrite: (pathToChmod) => fs.chmod(pathToChmod, 0o600).pipe(Effect.orElseSucceed(() => void 0)),
    seedLabel: "Claude credentials",
    updateLabel: "Claude credentials"
  })

// CHANGE: seed docker-git Claude auth store from host-level Claude files
// WHY: Claude Code (v2+) keeps OAuth session in ~/.claude.json and ~/.claude/.credentials.json
// QUOTE(ТЗ): "глобальная авторизация для клода ... должна сама везде настроиться"
// REF: user-request-2026-03-04-claude-global-auth-seed
// SOURCE: https://docs.anthropic.com/en/docs/claude-code/settings (section: \"Files and settings\", mentions ~/.claude.json)
// FORMAT THEOREM: ∀p: project(p) → (host_claude_auth_exists → project_claude_auth_seeded)
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError, FileSystem | Path>
// INVARIANT: never deletes existing auth data; only seeds missing/incomplete Claude auth files
// COMPLEXITY: O(1)
export const ensureClaudeAuthSeedFromHome = (
  baseDir: string,
  claudeAuthPath: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs, path }) =>
    Effect.gen(function*(_) {
      const homeDir = (process.env["HOME"] ?? "").trim()
      if (homeDir.length === 0) {
        return
      }

      const sourceClaudeJson = path.join(homeDir, ".claude.json")
      const sourceCredentials = path.join(homeDir, ".claude", ".credentials.json")

      const claudeRoot = resolvePathFromBase(path, baseDir, claudeAuthPath)
      const targetAccountDir = path.join(claudeRoot, "default")
      const targetClaudeJson = path.join(targetAccountDir, ".claude.json")
      const targetCredentials = path.join(targetAccountDir, ".credentials.json")

      yield* _(fs.makeDirectory(targetAccountDir, { recursive: true }))
      yield* _(syncClaudeHomeJson(fs, path, sourceClaudeJson, targetClaudeJson))
      yield* _(syncClaudeCredentialsJson(fs, path, sourceCredentials, targetCredentials))
    })
  )

// CHANGE: ensure Codex config exists with full-access defaults
// WHY: enable all codex commands without extra prompts inside containers
// QUOTE(ТЗ): "сразу настраивал полностью весь доступ ко всем командам"
// REF: user-request-2026-01-30-codex-config
// SOURCE: n/a
// FORMAT THEOREM: forall p: writable(config(p)) -> config(p)=defaults; permission_denied(config(p)) -> warning_logged
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError, FileSystem | Path>
// INVARIANT: rewrites only docker-git-managed configs to keep defaults in sync, permission-denied writes are skipped
// COMPLEXITY: O(n) where n = |config|
export const ensureCodexConfigFile = (
  baseDir: string,
  codexAuthPath: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs, path }) =>
    Effect.gen(function*(_) {
      const resolved = resolvePathFromBase(path, baseDir, codexAuthPath)
      const configPath = path.join(resolved, "config.toml")
      const writeConfig = Effect.gen(function*(__) {
        const exists = yield* __(fs.exists(configPath))
        if (exists) {
          const current = yield* __(fs.readFileString(configPath))
          if (!shouldRewriteDockerGitCodexConfig(current)) {
            return
          }
          yield* __(fs.writeFileString(configPath, defaultCodexConfig))
          yield* __(Effect.log(`Updated Codex config at ${configPath}`))
          return
        }
        yield* __(fs.makeDirectory(resolved, { recursive: true }))
        yield* __(fs.writeFileString(configPath, defaultCodexConfig))
        yield* __(Effect.log(`Created Codex config at ${configPath}`))
      })
      yield* _(
        writeConfig.pipe(
          Effect.matchEffect({
            onFailure: (error) => skipCodexConfigPermissionDenied(configPath, error),
            onSuccess: () => Effect.void
          })
        )
      )
    })
  )

export const syncAuthArtifacts = (
  spec: AuthSyncSpec
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs, path }) =>
    Effect.gen(function*(_) {
      const sourceGlobal = resolvePathFromBase(path, spec.sourceBase, spec.source.envGlobalPath)
      const targetGlobal = resolvePathFromBase(path, spec.targetBase, spec.target.envGlobalPath)
      const sourceProject = resolvePathFromBase(path, spec.sourceBase, spec.source.envProjectPath)
      const targetProject = resolvePathFromBase(path, spec.targetBase, spec.target.envProjectPath)
      const sourceCodex = resolvePathFromBase(path, spec.sourceBase, spec.source.codexAuthPath)
      const targetCodex = resolvePathFromBase(path, spec.targetBase, spec.target.codexAuthPath)

      yield* _(copyFileIfNeeded(sourceGlobal, targetGlobal))
      yield* _(syncGithubTokenKeysInFile(sourceGlobal, targetGlobal))
      yield* _(copyFileIfNeeded(sourceProject, targetProject))
      yield* _(fs.makeDirectory(targetCodex, { recursive: true }))
      if (sourceCodex !== targetCodex) {
        const sourceExists = yield* _(fs.exists(sourceCodex))
        if (sourceExists) {
          const sourceInfo = yield* _(fs.stat(sourceCodex))
          if (sourceInfo.type === "Directory") {
            const targetExists = yield* _(fs.exists(targetCodex))
            if (!targetExists) {
              yield* _(fs.makeDirectory(targetCodex, { recursive: true }))
            }
            // NOTE: We intentionally do not copy auth.json.
            // ChatGPT refresh tokens are rotating; copying them into each project causes refresh_token_reused.
            yield* _(
              copyCodexFile(fs, path, {
                sourceDir: sourceCodex,
                targetDir: targetCodex,
                fileName: "config.toml",
                label: "config"
              })
            )
          }
        }
      }
    })
  )

export const migrateLegacyOrchLayout = (
  baseDir: string,
  paths: LegacyOrchPaths
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  withFsPathContext(({ fs, path }) =>
    Effect.gen(function*(_) {
      const legacyRoot = path.resolve(baseDir, ".orch")
      const legacyExists = yield* _(fs.exists(legacyRoot))
      if (!legacyExists) {
        return
      }
      const legacyInfo = yield* _(fs.stat(legacyRoot))
      if (legacyInfo.type !== "Directory") {
        return
      }

      const legacyEnvGlobal = path.join(legacyRoot, "env", "global.env")
      const legacyEnvProject = path.join(legacyRoot, "env", "project.env")
      const legacyCodex = path.join(legacyRoot, "auth", "codex")
      const legacyGh = path.join(legacyRoot, "auth", "gh")
      const legacyClaude = path.join(legacyRoot, "auth", "claude")

      const resolvedEnvGlobal = resolvePathFromBase(path, baseDir, paths.envGlobalPath)
      const resolvedEnvProject = resolvePathFromBase(path, baseDir, paths.envProjectPath)
      const resolvedCodex = resolvePathFromBase(path, baseDir, paths.codexAuthPath)
      const resolvedGh = resolvePathFromBase(path, baseDir, paths.ghAuthPath)
      const resolvedClaude = resolvePathFromBase(path, baseDir, paths.claudeAuthPath)

      yield* _(copyFileIfNeeded(legacyEnvGlobal, resolvedEnvGlobal))
      yield* _(copyFileIfNeeded(legacyEnvProject, resolvedEnvProject))
      yield* _(copyDirIfEmpty(fs, path, legacyCodex, resolvedCodex, "Codex auth"))
      yield* _(copyDirIfEmpty(fs, path, legacyGh, resolvedGh, "GH auth"))
      yield* _(copyDirIfEmpty(fs, path, legacyClaude, resolvedClaude, "Claude auth"))
    })
  )
