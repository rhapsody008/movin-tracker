# Go golden generators

The v3 TypeScript tests compare their ports with Go's own answers, not with a
guess. Those answers live in `app/src/**/testdata/*.go.json` (and `*.go.err`),
and every one of them was written by a small Go program in this directory.

**They need the Go code.** Each generator imports the real Go packages
(`internal/entries`, `internal/docs`, `internal/server`, …), so the outputs are
final: regenerate them here while the Go code still compiles, and T7 can then
delete Go without losing the fixtures. Nothing in `app/golden/` is compiled by
`go build ./...`, `go vet ./...`, `make lint` or `make test`: every file starts
with `//go:build ignore`, and an explicit `go run <file>` ignores the tag.

Run them from the repo root, in the Go tools container. The prefix is the same
for all of them, and each command in the table is completed by putting it after
`go run ./app/golden/` (the `<args>` of the prefix):

```
docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/<x>/main.go <args>'
```

| Generator | Writes                                                                                                                                        | `go run ./app/golden/` +                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t13`     | `app/src/entries/testdata/<input>.go.json` (Go's stored bytes) and `<input>.go.err` (Go's decode error) for each `*.json` input               | `t13/main.go app/src/entries/testdata/*.json`                                                                                                                                                                       |
| `t14`     | `app/src/settings/testdata/{settings-go,settings-go-claude,save-telegram.go,save-checkin.go}.json`, `app/src/testdata/{sortkeys,raw}.go.json` | `t14/main.go save app/src/settings/testdata/settings-go.json`, `t14/main.go claude app/src/settings/testdata/settings-go-claude.json`, `t14/main.go savebytes`, `t14/main.go sortkeys`, `t14/main.go rawtable`      |
| `t15`     | `app/src/docs/testdata/{empty,index,nulls,tricky}.go.json` and `pages.go.json`                                                                | `t15/main.go app/src/docs/testdata/index.json app/src/docs/testdata/tricky.json app/src/docs/testdata/empty.json app/src/docs/testdata/nulls.json`, then `t15/main.go -kind=pages app/src/docs/testdata/pages.json` |
| `t15c`    | `app/src/docs/testdata/search/{search-index,search-texts,search-hits.go}.json`, `app/src/testdata/sched.go.json`                              | `t15c/main.go`                                                                                                                                                                                                      |
| `t21`     | `app/src/server/testdata/transcript.go.json`, `app/src/server/testdata/changetext.go.json`                                                    | `t21/main.go`                                                                                                                                                                                                       |
| `t22`     | `app/src/server/testdata/transcript-admin.go.json`                                                                                            | `t22/main.go`                                                                                                                                                                                                       |
| `t2x`     | nothing: it prints, and the tests quote its lines                                                                                             | `t2x/main.go`                                                                                                                                                                                                       |
| `t31`     | `app/src/llm/testdata/striptokens.go.json`                                                                                                    | `t31/main.go`                                                                                                                                                                                                       |
| `t33`     | stdout is `app/src/agent/testdata/tools.go.json`                                                                                              | `t33/main.go \| cmp - app/src/agent/testdata/tools.go.json`                                                                                                                                                         |
| `t34`     | stdout is `app/src/agent/testdata/prompt.go.json`                                                                                             | `t34/main.go \| cmp - app/src/agent/testdata/prompt.go.json`                                                                                                                                                        |
| `t41`     | stdout is `app/src/telegram/testdata/requests.go.json`                                                                                        | `t41/main.go \| cmp - app/src/telegram/testdata/requests.go.json`                                                                                                                                                   |
| `t43`     | stdout is `app/src/telegram/testdata/format.go.json`                                                                                          | `t43/main.go \| cmp - app/src/telegram/testdata/format.go.json`                                                                                                                                                     |
| `t44`     | stdout is `app/src/telegram/testdata/commands.go.json`                                                                                        | `t44/main.go \| cmp - app/src/telegram/testdata/commands.go.json`                                                                                                                                                   |
| `t51`     | stdout is `app/src/telegram/testdata/checkin.go.json`                                                                                         | `t51/main.go \| cmp - app/src/telegram/testdata/checkin.go.json`                                                                                                                                                    |

Every generator runs on a fixed clock and an in-memory store: none reads
today's date, the bucket or MinIO. Four generated files are not byte-stable,
and the tests cope with each the way the generator's header says:

- `t14 save` and `t14 claude` encrypt a key with a fresh Fernet IV, so
  `apiKeyEnc` differs on every run; the settings tests decrypt it and compare
  the plaintext.
- `t21` and `t22` run a live HTTP server, so the transcript holds freshly
  minted ULIDs, ETags, `lastWrite.at` and a probe ULID. Both transcript tests
  mask exactly those fields on both sides before comparing.

Everything else regenerates byte for byte; after a run,
`git status --short app/src` must be empty.
