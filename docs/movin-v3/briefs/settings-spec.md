# Spec: Go `internal/settings` (porting reference for T1.4)

Produced by code-explorer on 2026-11-20 from the frozen Go code:
`internal/settings/settings.go`, `telegram.go`, `checkin.go` plus their tests, the
Fernet vendor copy, `internal/config`, and the callers. Line numbers refer to those
files. Where this file and the Go source disagree, the Go source wins; report the
difference.

Scope: the exact behaviour a byte-compatible TypeScript port must reproduce, plus
which of those behaviours **v2 deliberately changes** (section 11, from
`docs/movin-v3/plan.md:55-63` and `:101`).

---

## 1. `settings.json`: structure, order, `omitempty`, encryption

Object key `settings.json` at the store root (`settings.go:23`; the objstore prefix
is applied by the store, not here).

### 1.1 Decoded shape (`stored`, `settings.go:64-71`)

| # | Go field | JSON | Type | Tag | Notes |
|---|---|---|---|---|---|
| 1 | Schema | `schema` | int | none | always present in Go-written files |
| 2 | LLM | `llm` | `storedLLM` | none | always written; a missing key decodes to all-nil |
| 3 | Telegram | `telegram` | `*storedTelegram` | `telegram,omitempty` | absent = use env |
| 4 | Checkin | `checkin` | `*storedCheckin` | `checkin,omitempty` | absent = use env |
| 5 | Updated | `updated` | string | `updated,omitempty` | **LLM** last-saved time |
| 6 | By | `by` | string | `by,omitempty` | **LLM** last-saved actor |

### 1.2 `llm` section (`storedLLM`, `settings.go:73-82`)

Every field is a pointer with `omitempty`; order = JSON byte order:

| # | JSON | Type | Notes |
|---|---|---|---|
| 1 | `vision` | bool | Save check's image probe; always written by Save |
| 2 | `kind` | string | `openai` \| `claude`; empty/absent = openai |
| 3 | `baseUrl` | string | trailing slashes trimmed on save |
| 4 | `apiKeyEnc` | string | **the only encrypted field**: Fernet token of the API key |
| 5 | `model` | string | trimmed on save |
| 6 | `streaming` | bool | |
| 7 | `thinkOnDemand` | bool | |

`Save` sets all pointers except `apiKeyEnc` (`settings.go:490-500`), so a Go-written
llm section always has `vision, kind, baseUrl, model, streaming, thinkOnDemand` in
that order, with `apiKeyEnc` in position 4 when a key is stored.
**Note:** `plan.md:59` lists a different order (`kind` first); the Go source writes
`vision` first. Follow the source.

Legacy keys inside `llm` (`temperature`, `maxTokens`, see `settings_test.go:20-25`)
are **not** in `storedLLM`: they are ignored on read and **dropped** the first time
the llm section is saved (the section is rewritten from the struct). No test asserts
their survival.

### 1.3 `telegram` section (`storedTelegram`, `telegram.go:52-57`)

`users` (`[{id,name}]`, no `omitempty`), `groups` (`[]string`, no `omitempty`),
`updated` (`omitempty`), `by` (`omitempty`). `TelegramUser` is `{id,name}`, both
strings, IDs as decimal strings (`telegram.go:16-19`).

### 1.4 `checkin` section (`storedCheckin`, `checkin.go:36-41`)

`schedule` (always, `"HH:MM"` or `"off"`), `chat` (`omitempty`, decimal chat ID
string), `updated` (`omitempty`), `by` (`omitempty`).

### 1.5 Unknown sections and keys

Writes go through one path, `modify` (`settings.go:248-286`):

- read the object as `map[string]json.RawMessage` (raw passthrough, per top-level key);
- hand it to the section's callback, which only replaces/deletes *its own* key;
- force `raw["schema"] = json.RawMessage("1")` (`settings.go:268`);
- `json.MarshalIndent(raw, "", "  ")` (`settings.go:269`) and conditional-Put.

Consequences a port must match:

| Behaviour | Detail |
|---|---|
| Unknown top-level sections survive | e.g. `"stt": {"model":"whisper"}` (`settings_test.go:104`), asserted at `settings_test.go:114-116` |
| Top-level key order becomes **alphabetical** | Go marshals a map with sorted string keys. A Go-written file orders top-level keys `by, checkin, llm, schema, telegram, updated` + unknown keys interleaved alphabetically. This differs from the struct order above, which is only used when *decoding*. |
| Indentation | two spaces, `MarshalIndent`, **no trailing newline**. Every object element and array element on its own line; `[]` and `{}` stay inline. |
| Raw values are re-compacted and re-indented | `RawMessage` implements `Marshaler`; the encoder runs `appendCompact(…, escapeHTML=true)` (`$GOROOT/src/encoding/json/encode.go:472-492`), then `Indent`. Whitespace inside an unknown section is normalised; a compact unknown section is expanded to the 2-space style. |
| Raw values are HTML-escaped | `<`→`\u003c`, `>`→`\u003e`, `&`→`\u0026`, U+2028/2029 → `\u2028`/`\u2029` (`indent.go:51-90`). Applies to raw passthrough **and** to marshalled structs (Go's `escapeHTML` default is on; nothing in the repo turns it off). |
| Unknown keys *inside* a known section are dropped | when that section is saved (struct re-marshal replaces the whole value) |
| Duplicate keys inside unknown sections | preserved verbatim by the raw passthrough (a `JSON.parse`-based port cannot reproduce this) |
| Unreadable file | top-level JSON that does not unmarshal into the map is **replaced**: warns `replacing unreadable settings.json` (`settings.go:255-257`) and writes the new sections from scratch (asserted `settings_test.go:236-242`) |
| `schema` | always forced to the literal `1`, on every save of every section, including `useEnv` saves |

Hazard (Go bug, do not necessarily reproduce): a file containing the JSON literal
`null` unmarshals into a **nil** map; `raw["schema"] = …` then panics (assignment to
entry in nil map). The TS port should reject/ignore such a body instead.

---

## 2. Fernet: key handling, token format, errors

Vendor copy: `vendor/github.com/fernet/fernet-go/{fernet.go,key.go}`; it implements
the Fernet spec (AES-128-CBC + HMAC-SHA256, version 0x80).

### 2.1 `SETTINGS_SECRET` → key (`settings.go:146-158`, `key.go:33-58`)

- `config.Load` reads `SETTINGS_SECRET` via `env()` → trimmed, empty string if unset
  (`config.go:73`).
- `NewService(store, env, secret, log)`: if `secret == ""` → `s.fkey = nil`, no error;
  otherwise `fernet.DecodeKey(secret)`; on error the constructor fails with
  `SETTINGS_SECRET is not a valid Fernet key: <cause>` (`settings.go:153-154`) — the
  process does not start (`cmd/movin/main.go:96-98`). With no secret the process
  starts and logs `SETTINGS_SECRET is not set; the settings drawer cannot store an API
  key` (`cmd/movin/main.go:99-101`).
- `DecodeKey`:
  1. `""` → error `empty key` (unreachable here, guarded).
  2. exactly 64 characters → hex decode.
  3. else base64 **standard with padding** (`base64.StdEncoding`), falling back to
     base64 **URL-safe with padding** (`base64.URLEncoding`).
  4. decoded length must be 32, else `fernet: key decodes to wrong size`.
  5. Unpadded base64 (43 chars) is **not** accepted; the error is Go's base64 error
     (`illegal base64 data at input byte N`).
- Key halves: `signKey = k[0:16]` (HMAC), `cryptKey = k[16:32]` (AES-128)
  (`key.go:22-28`).

### 2.2 Token format (`fernet.go:14-27`, `:53-71`)

```
token  = base64url_padded( version || ts || iv || ciphertext || hmac )
version    = 0x80                         (1 byte)
ts         = unix seconds, big-endian     (8 bytes)
iv         = 16 random bytes              (16 bytes)
ciphertext = AES-128-CBC(cryptKey, iv, PKCS#7-pad(plaintext))   ≥ 1 block
hmac       = HMAC-SHA256(signKey, version||ts||iv||ciphertext)  (32 bytes)
```

- Base64 alphabet: **URL-safe, WITH `=` padding** (`encoding = base64.URLEncoding`,
  `fernet.go:30-31`).
- Padding is always applied, so a plaintext that is a multiple of 16 gets a whole
  extra block. For an *n*-byte key the binary token is
  `1+8+16+ (⌊n/16⌋*16+16) + 32` bytes, then base64.
- Written by `fernet.EncryptAndSign(plaintext, key)` = `EncryptAndSignAtTime(…, time.Now())`
  (`settings.go:479-486`).

### 2.3 Verification (`settings.go:300-310`, `fernet.go:73-120`, `:138-151`)

- `decrypt` = `fernet.VerifyAndDecrypt([]byte(enc), ttl = 0, [fkey])`.
- **`ttl = 0` disables every time check**: `if ttl > 0 && (now.After(ts.Add(ttl)) || ts.After(now.Add(maxClockSkew)))`
  (`fernet.go:85-87`). So stored keys never expire and a future timestamp is fine.
  `maxClockSkew = 60s` exists but only matters when `ttl > 0`.
- Verify steps, any failure → `nil` (no error value): length ≥ 9 and `tok[0] == 0x80`;
  `len-32 > 0`; HMAC compare in constant time; ciphertext length multiple of 16;
  PKCS#7 unpad well-formed.
- Base64 decoding is lenient: `n, _ := encoding.Decode(b, tok)` ignores errors and
  uses whatever prefix decoded (`fernet.go:139-141`). Trailing `\r`/`\n` are skipped
  by Go's decoder; standard-alphabet `+`/`/` break it.
- `fkey == nil` → `("", false)` immediately.
- **Wrong `SETTINGS_SECRET`** (valid 32-byte key, wrong bytes) → HMAC mismatch →
  `("", false)`. **Corrupt/truncated token** → same. No distinction, no error surfaced.
- Only observable signal: `s.log.Warn("stored API key could not be decrypted; using LLM_API_KEY instead (check SETTINGS_SECRET)")`
  (`settings.go:332`) — **not** `warnOnce`, so it logs on *every* resolve (every
  message). The env `LLM_API_KEY` (if it belongs to the resolved origin) is used
  instead.
- Success: decrypted bytes as a UTF-8 string, key stays in memory only.

### 2.4 Cross-language vectors (use these as the TS conformance test)

The Fernet spec vectors are vendored and are exactly what a TS port needs:

- `vendor/github.com/fernet/fernet-go/verify.json:1-14` — secret
  `cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=`, token
  `gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==`,
  plaintext `hello`.
- `vendor/github.com/fernet/fernet-go/generate.json:1-9` — same secret/plaintext with
  a fixed IV, ts and expected token (for the encrypt direction).

**There is no static Go-encrypted `settings.json` fixture in the repo today**:
`fixtures/` holds only `entries.sample.json`, and every settings test generates a key
at runtime (`settings_test.go:39-42`, `kind_test.go:199-201`, `kind_test.go:247-249`).
T1.4's "a Go-encrypted key fixture decrypts" therefore needs one created; the
Fernet vectors above are the cheapest way to prove the crypto, and a small
`settings.json` containing a Go-produced `apiKeyEnc` (key + token both generated by
the Go code, or by a TS implementation that passes the vectors) should be checked in
and its path referenced from the v2 test.

---

## 3. The LLM section

### 3.1 Types

- Resolved connection `LLM` (`settings.go:36-55`), field order: `Kind, Vision,
  BaseURL, APIKey, Model, TimeoutSec, MaxToolRounds, Streaming, ThinkOnDemand`
  (no JSON tags — never marshalled to the client).
- `Defaults = LLM{TimeoutSec: 600, MaxToolRounds: 5, Streaming: true}`
  (`settings.go:60`). A **package-level var**; callers copy it (`config.go:88`).
  `TimeoutSec`/`MaxToolRounds` are never read from or written to `settings.json`
  and have no env vars.
- `Kind` constants: `KindOpenAI = "openai"`, `KindClaude = "claude"`
  (`settings.go:27-28`); `ClaudeOrigin = "https://api.anthropic.com"`
  (`settings.go:33`).

### 3.2 Resolution, env over defaults over file (`resolve`, `settings.go:312-359`)

Exact order; `out := s.env` (env already includes `Defaults`):

```
keyFromEnv = s.env.APIKey != ""
if llm.kind != nil && (*kind == "openai" || *kind == "claude") -> out.Kind = *kind
       (anything else in the file — "" , "gpt", null — is ignored: env kind stays)
if llm.baseUrl != nil -> out.BaseURL = *baseUrl      (even if "")
if llm.vision  != nil -> out.Vision  = *vision
if out.Kind == "claude" -> out.BaseURL = claudeURL; out.Vision = true    // fixed origin
if llm.apiKeyEnc != nil:
    k, ok = decrypt(apiKeyEnc)
    case !ok                          -> warn (every call, see 2.3), env key stays candidate
    case llm.baseUrl == nil || !SameOrigin(*llm.baseUrl, out.BaseURL)
                                      -> warnOnce "stored API key belongs to another host;
                                         not using it" (savedFor=<origin>, target=<origin>),
                                         env key stays candidate
    default                           -> out.APIKey = k; keyFromEnv = false
if llm.model         != nil -> out.Model = *model
if llm.streaming     != nil -> out.Streaming = *streaming
if llm.thinkOnDemand != nil -> out.ThinkOnDemand = *thinkOnDemand
if keyFromEnv && s.env.BaseURL != "" && !SameOrigin(out.BaseURL, s.env.BaseURL) -> out.APIKey = ""
return out, keyFromEnv && out.APIKey != ""
```

Second return value = "the key in use came from `LLM_API_KEY`" (only used for the
view's `keyFromEnv`).

Note the empty-string hole: if `LLM_BASE_URL` is unset the env-key binding check is
skipped entirely, so `LLM_API_KEY` is then sent to whatever endpoint the page saved.

### 3.3 Origin binding: what it is and the rules

Purpose: an API key is only ever sent to the scheme+host+port its configuration named.
It is enforced in three places, all of which a port needs:

1. **Pass-through read** (`resolve`, above): a stored key is used only if the file
   also stored the `baseUrl` it belongs to and that origin equals the resolved target.
   Hand-edited file without `baseUrl` → the key is never used (and it is dropped on
   the next save, see §3.5).
2. **Env key** (`resolve`): `LLM_API_KEY` belongs to `LLM_BASE_URL`; if the resolved
   target has a different origin, the key is blanked.
3. **Per-request endpoints** (`KeyFor`, `settings.go:386-397`): `typed` key wins
   unconditionally; otherwise the resolved key only if `SameOrigin(baseURL,
   resolved.BaseURL)`. Used by "Test connection" and the models list, both of which
   take a URL from the request (`server.go:603`, `settings.go:452`).

`SameOrigin(a, b)` (`settings.go:374-385`):

- `url.Parse(strings.TrimSpace(x))` for both; any parse error, or `ua.Host == ""` → false.
- Compare `Scheme` and `Host` with `strings.EqualFold` (ASCII case-insensitive).
- `Host` includes an explicit port; **no default-port folding**
  (`https://h:443` ≠ `https://h`). Path/query are ignored (so `https://h/v1` and
  `https://h/v1/` are the same origin). Userinfo and fragments are irrelevant.
- `originOf` (`settings.go:361-372`) renders `scheme://host` for log details only.

Tests covering it: `kind_test.go:81` (host change without typing a key drops the
stored key), `kind_test.go:105` (same origin, different path → key carries over),
`kind_test.go:125` (env key not sent to Claude), `kind_test.go:196` (stored key vs
`LLM_KIND`/origin override, `KeyFor`), `kind_test.go:243` (URL-less key never used,
one warning), plus server-level `server_test.go:793` and the leak test at `:418`.

### 3.4 Where the key is decrypted; how it is kept out of views and errors

- Decrypted **only** inside `resolve` (`settings.go:330-341`) and only for a
  `settings.json` `apiKeyEnc`. There is no decrypt-on-save; Save always re-encrypts
  what it was given.
- The client-facing struct is `View` (`settings.go:97-111`), field order:
  `vision, claudeOrigin, kind, baseUrl, model, streaming, thinkOnDemand, keySet,
  keyLast4(omitempty), keyFromEnv, canStoreKey, updated(omitempty), by(omitempty)`.
  There is **no field that can carry the key**; only `keySet` (bool) and
  `keyLast4` (last **4 bytes** of the plaintext key, only when `len >= 8` —
  `settings.go:411-413`, so a multibyte tail can be split).
- `canStoreKey = fkey != nil`; `keyFromEnv` as in §3.2; `updated`/`by` come from the
  **top level** of the file (i.e. "LLM last saved", kept for v1 files, `settings_test.go:140-142`).
- Logging: `Save` logs `LLM settings saved` with `by, kind, model, baseUrl, keyChanged`
  (`settings.go:516`) — never the key. The llm layer additionally redacts the key from
  provider errors (`internal/llm/openai.go:93-99`, `claude.go:440-446`).
- Gate test: `server_test.go:418 TestSettingsKeyNeverLeaks` — asserts the plaintext
  never appears in any of save/view/test/models/chat responses nor in any log line,
  and that the file holds `apiKeyEnc` and not the key; also `keyLast4 == "7f3a"`,
  `by == "zy@example.com"`, empty key keeps the stored one, `clearKey` falls back to
  the env key (`keyLast4 == "aaaa"`, `keyFromEnv == true`).
- The page only reads these masks (`static/index.html:1058-1065`).

### 3.5 Validation, `normalise`, `ForTest`, `Save`

`ValidationError{Msg}` (`settings.go:113-115`) with `Error() = Msg`; the server maps
it to **400** with that message (`server.go:197-199`).

`normalise(in Input)` (`settings.go:420-431`) — used by ForTest and Save:

| `in.Kind` | effect |
|---|---|
| `""` | becomes `openai` |
| `openai` | unchanged |
| `claude` | `in.BaseURL = claudeURL` (a request URL never redirects it) |
| anything else | `ValidationError{"kind must be openai or claude"}` (`:428`) |

then `validate()` (`settings.go:433-444`):

- `url.Parse(strings.TrimSpace(baseUrl))`; error, or scheme not `http`/`https`, or
  empty host → `ValidationError{"endpoint URL must start with http:// or https://"}`
  (`:436`).
- `strings.TrimSpace(model) == ""` → `ValidationError{"model is required"}` (`:440`).

`Input` (`settings.go:84-95`), field order: `vision, kind, baseUrl, apiKey,
clearKey, model, streaming, thinkOnDemand` (only the request shape; no tags matter
beyond names). `apiKey == ""` = keep the stored key; `clearKey` = explicit removal.

`ForTest` (`settings.go:447-466`):

```
normalise(in)                                    // errors returned
base = TrimRight(TrimSpace(in.BaseURL), "/")
key  = KeyFor(ctx, base, in.APIKey)              // typed wins; else stored/env key iff same origin
if in.ClearKey && in.APIKey == "":
     key = ""
     if env.APIKey != "" && (env.BaseURL == "" || SameOrigin(base, env.BaseURL)): key = env.APIKey
return LLM{Kind, Vision: in.Vision || Kind=="claude", BaseURL: base, APIKey: key,
           Model: TrimSpace(in.Model), TimeoutSec: env.TimeoutSec,
           MaxToolRounds: env.MaxToolRounds, Streaming: in.Streaming,
           ThinkOnDemand: in.ThinkOnDemand}
```

It never reads the file except through `KeyFor`, and it never saves. The server then
forces `cfg.Streaming = false` before probing (`server.go:531`).

`Save(ctx, by, in)` (`settings.go:469-518`):

1. `normalise`; on error → `(View{}, err)`.
2. `in.APIKey != "" && fkey == nil` →
   `ValidationError{"SETTINGS_SECRET is not configured on the server, so a key cannot be stored. Set LLM_API_KEY instead."}`
   (`:475`).
3. `in.APIKey != ""` → `enc = fernet.EncryptAndSign([]byte(in.APIKey), fkey)`.
4. `baseURL = TrimRight(TrimSpace(in.BaseURL), "/")`, `model = TrimSpace(in.Model)`.
5. `modify` callback:
   - `old` = `json.Unmarshal(raw["llm"], &storedLLM{})` (errors ignored);
   - `keep = old.APIKeyEnc`; `if in.ClearKey { keep = nil }`;
   - `if keep != nil && enc == nil && (old.BaseURL == nil || !SameOrigin(baseURL, *old.BaseURL)) { keep = nil }`
     → moving host without typing a key drops it (a URL-less stored key also has no
     host to belong to, so it is dropped too);
   - `if enc != nil { keep = enc }`;
   - `setJSON(raw, "llm", storedLLM{Kind, Vision, BaseURL, APIKeyEnc: keep, Model, Streaming, ThinkOnDemand})`
     — all addresses taken from `in`, i.e. every non-key field is **overwritten**
     from the request (an absent JSON field becomes `false`/`""`, so a partial PUT
     wipes flags);
   - `setJSON(raw, "updated", s.now().UTC().Format(time.RFC3339))`,
     `setJSON(raw, "by", by)`.
6. returns `s.View(ctx)` (fresh read, cache just updated).

`View` construction (`settings.go:404-419`): `ClaudeOrigin = claudeURL`,
`KeySet = resolved.APIKey != ""`, `KeyFromEnv = fromEnv && APIKey != ""`,
`CanStoreKey = fkey != nil`, `Updated/By` top-level.

---

## 4. Telegram and check-in

### 4.1 Telegram: fields, resolution, validation

- Resolved `Telegram` (`telegram.go:24-28`): `users` (`[]TelegramUser{id,name}`),
  `groups` (`[]string`), `fromEnv` (bool). Always non-nil slices when resolved.
- Helpers: `UserName(id int64) (string, bool)` and `GroupAllowed(id int64) bool`
  compare against `strconv.FormatInt(id, 10)` (`telegram.go:31-50`).
- `TelegramInput` (`telegram.go:61-65`): `users`, `groups`, `useEnv`.
- `TelegramView` (`telegram.go:68-71`): embeds `Telegram` then `updated`, `by`
  (`omitempty`) — JSON `{users, groups, fromEnv, updated?, by?}`.

`validTelegram(users, groups)` (`telegram.go:82-127`), normalising and rejecting:

| Rule | Normalisation | Error message |
|---|---|---|
| ≤ 20 users | — | `at most 20 Telegram users` |
| ≤ 10 groups | — | `at most 10 Telegram groups` |
| user ID decimal int64 > 0 | `TrimSpace` then `ParseInt` then `FormatInt` | `Telegram user ID "<raw input>" must be a positive number` |
| name, whitespace-collapsed, 1–40 **runes** | `strings.Join(strings.Fields(name), " ")` | `name for Telegram user <normalised id> must be 1-40 characters` |
| no duplicate user ID | | `Telegram user <id> is listed twice` |
| names unique, compared with `strings.ToLower` | | `two Telegram users are named "<name>"; give each a different name` |
| group ID decimal int64 < 0 | `TrimSpace`, `ParseInt`, `FormatInt` | `Telegram group ID "<raw input>" must be a negative number (group IDs start with -)` |
| no duplicate group ID | | `Telegram group <id> is listed twice` |

Returned slices are non-nil empty slices when the input is empty; on error both
returns are `nil`.

`ParseTelegramEnv(ids, chats)` (`telegram.go:130-153`) — env parsing:

- split `ids` on `,`, trim each, skip empties;
- `id, name, ok := strings.Cut(part, "=")`; if no `=` **or** `TrimSpace(name) == ""`
  → `name = id` (the raw pre-`=` text; the part itself is already trimmed);
- `TelegramUser{ID: strings.TrimSpace(id), Name: name}`;
- split `chats` on `,`, trim, skip empties;
- run `validTelegram`; an error is wrapped as
  `TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS: <validation message>`
  (`telegram.go:146-148`);
- success → `Telegram{Users, Groups, FromEnv: true}`.

`resolveTelegram` (`telegram.go:155-176`):

- `st.Telegram == nil` → copy `s.tgEnv`, `FromEnv = true`, nil slices → `[]`.
- section present → re-validate it; on failure `warnOnce("telegram section of
  settings.json is invalid, using env allowlist", "err", err)` and **recurse with an
  empty `stored`** (i.e. env). A valid section yields `FromEnv = false`.
- An **empty stored list allows nobody** — it never falls back to env
  (`settings_test.go:170-174`).

`SaveTelegram` (`telegram.go:192-214`): `!UseEnv` → validate first (a rejected input
writes nothing, `settings_test.go:200-203`); then `modify`: `UseEnv` → `delete(raw,
"telegram")`, else `setJSON` the section with `Updated = now UTC RFC3339`, `By = by`.
Logs `Telegram allowlist saved` with `by, users(n), groups(n), useEnv`. Returns
`ViewTelegram`.

`ViewTelegram` (`telegram.go:182-190`): resolved value plus `updated`/`by` **only
when the section exists**.

### 4.2 Check-in: fields, defaults, validation

- `DefaultCheckin = "09:30"` (`checkin.go:15`); cutoff `sched.CheckinCutoff = 20`
  (`internal/sched/sched.go:39`).
- `Checkin` (`checkin.go:18-29`): `schedule` ("HH:MM" or "off"), `chat` (decimal ID,
  `""` = default: first allowed group, else first allowed person), `fromEnv`;
  `On`, `Hour`, `Minute` are `json:"-"` (internal only) — plus `ChatID() int64`
  (`"garbage"` → 0, `checkin.go:31-34`).
- `CheckinInput` (`checkin.go:45-49`): `schedule`, `chat`, `useEnv`.
- `CheckinSetting` (`checkin.go:52-60`): embeds `Checkin`, then `updated`, `by`,
  `unreadable` (all `omitempty`) — JSON `{schedule, chat, fromEnv, updated?, by?,
  unreadable?}`. `chat` is **always present** (no `omitempty` on `Checkin.Chat`).

`ParseCheckin(schedule, chat)` (`checkin.go:63-85`):

1. `sched.Parse("the check-in time", schedule, "09:30")` (`sched.go:13-29`):
   trim + lowercase; `off|none|false` → off `(0,0,false)`; empty → the default;
   otherwise `H:M` with `Atoi` on both halves, `0≤hh≤23`, `0≤mm≤59`; failure →
   `the check-in time must be HH:MM (24 h) or off, not "<input>"`, wrapped as a
   `ValidationError` verbatim (`checkin.go:65-68`). So `"7:05"` and `"07:5"` are valid
   and normalise to `"07:05"`.
2. `on && hh >= 20` → `the check-in time must be before 20:00 (later ones are skipped)`
   (`checkin.go:69`).
3. `Schedule` = `"off"` or `fmt.Sprintf("%02d:%02d", hh, mm)`; `On`/`Hour`/`Minute` set.
4. chat: `TrimSpace`; `""` → keep `""`; else `ParseInt` base 10, 64-bit; error **or**
   `id == 0` → `the check-in chat must be a Telegram chat ID (a number), not "<chat>"`
   (`checkin.go:78`); otherwise `Chat = FormatInt(id)` (positive IDs allowed).

`resolveCheckin` (`checkin.go:89-104`):

- `st.Checkin == nil` → use `s.ciEnv`; if `ciEnv.Schedule == ""` (never configured)
  → `ParseCheckin("", "")` = the 09:30 default; `FromEnv = true`.
- section present → re-`ParseCheckin`; invalid → `warnOnce("checkin section of
  settings.json is invalid, using the server's setting", "err", err)` then resolve as
  if absent (env).

`ResolveCheckin` (`checkin.go:111-117`) is the **one strict reader**: it uses
`currentErr` and returns `(Checkin{}, fmt.Errorf("read settings.json: %w", err))` on a
failed read. Rationale in code: a check-in saved as Off must not fire because of one
failed read (`internal/telegram/checkin.go:344-350`). Unknown-file (`ErrNotFound`) is
not an error.

`ViewCheckin` (`checkin.go:119-127`): resolved value + `Unreadable = err != nil` +
`updated`/`by` from the section.

`SaveCheckin` (`checkin.go:129-150`): `!UseEnv` → `ParseCheckin`; `UseEnv` →
`delete(raw, "checkin")`; else `setJSON` `{schedule, chat, updated, by}`. Logs
`check-in setting saved` with `by, schedule, chat, useEnv` (note: on `useEnv` the
logged schedule/chat are the zero values `""`/`""`).

Defaults summary: no stored section and no env → **on, 09:30, chat ""** (default
target), `fromEnv = true`. Env `CHECKIN_SCHEDULE=off` → off.

---

## 5. Load, save, concurrency

Store interface (`internal/objstore/objstore.go:11-32`): `Get` → `(body, etag, err)`
with `ErrNotFound`; `Put(key, body, ifMatch)` → `(etag, err)` with `ErrPrecondition`;
`ifMatch == ""` means `If-None-Match: *` (create-only).

Service state (`settings.go:124-144`): `store, env, tgEnv, ciEnv, claudeURL, fkey,
log, now func() time.Time, ttl, mu, cached stored, at time.Time, has bool, gen uint64,
warnMu, lastWarn map[string]string`.

Read path:

- `currentErr` (`settings.go:208-232`): cache hit when `has && now().Sub(at) < ttl`
  → return the decoded `stored` (a struct copy). Otherwise record `gen`, `load`; on
  success **or** `ErrNotFound` (missing file = zero `stored`, and it is cached) → if
  `s.gen != gen` a save landed during the read, so use `s.cached` instead of caching
  the stale copy; else cache it with `at = now()`. Other errors are returned.
- `current` (`settings.go:198-206`): `currentErr` + `warnOnce("settings.json
  unreadable, using env defaults", "err", err)`, returns zero `stored` (env applies).
- `load` (`settings.go:288-298`): `Get`, then `json.Unmarshal`; a decode failure
  becomes `decode settings.json: <err>`.
- `remember(body)` (`settings.go:234-246`): after every successful write, decode and
  replace the cache, `gen++`.
- `ttl = CacheTTL = 30s` (`settings.go:122`), overridable only in-package; clock
  injected via `SetClock` (`settings.go:192`).

Write path `modify` (`settings.go:248-286`):

```
for attempt := 0; ; attempt++ {
    raw := map[string]json.RawMessage{}
    body, etag, err := store.Get(Key)
    err == nil                -> unmarshal into raw; on failure warn "replacing unreadable
                                 settings.json" and start from an empty map
    ErrNotFound               -> etag = ""            // create-only put
    other                     -> return err
    fn(raw)                   -> error returned as-is (validation never happens here)
    raw["schema"] = 1
    out = MarshalIndent(raw, "", "  ")
    Put(Key, out, etag)       -> ok: remember(out); return nil
                              -> ErrPrecondition: if attempt >= 3 return ErrConflict; else retry
                              -> other: return err
}
```

- Up to **4** Put attempts (attempts 0,1,2,3); the 4th precondition failure returns
  `ErrConflict` (`settings.go:276-279`), mapped to **409** with
  `"These settings were changed somewhere else at the same moment. Reopen Settings and try again."`
  (`server.go:211-212`; test `server_test.go:867`).
- No polling, no background refresh, no subscribers: freshness for edits made by
  another replica is the 30 s TTL only (`settings_test.go:244`). The bot re-reads per
  update (`telegram/bot.go:256`, `:421`) and the check-in per minute
  (`telegram/checkin.go:344`), so changes apply without a restart.
- No cross-process lock: correctness rests on the ETag guard plus re-read/retry, which
  is why concurrent writes from another section survive (`settings_test.go:280`).
- `warnOnce` (`settings.go:164-173`) dedups on `msg` + `fmt.Sprint(args...)`; the
  entry is stored even for an unseen message, so a change in details logs again.

---

## 6. Every test

### `internal/settings/settings_test.go`

Fixtures/helpers: `v1File` (`:20-25`, v1 shape: `schema`, `llm` with
`temperature`/`maxTokens`, top-level `updated`/`by`), `rig` (`:27`), `newRig` (`:33`,
memory store, generated Fernet key, env LLM `https://env.example/v1` /
`env-model` / `sk-env-0000-aaaa`, clock `2026-11-11T09:00:00Z`), `raw` (`:55`),
`envTG` (`:68`, from `111=ZY, 222=Partner` + `-1001234`), `llmIn` (`:77`,
`https://new.example/v1` / `sk-new-secret-7f3a` / `m2`).

| Line | Test | Asserts |
|---|---|---|
| `:79` | `TestV1FileReadsAsBefore` | v1 file resolves to its own baseUrl/model, `streaming=false`, **no** key (env key bound to another host); view carries top-level `updated`/`by`, `keySet`/`keyFromEnv` false; pointing the file at the env origin brings `sk-env-0000-aaaa` back; telegram comes from env (`fromEnv`, 2 users, group allowed) |
| `:103` | `TestSectionsSurviveEachOthersSaves` | file with unknown section `stt`; a telegram save then an llm save keep `telegram` **and** `stt`; `llm.apiKeyEnc` present and the plaintext absent; a later telegram save keeps `apiKeyEnc`, `model`, `stt`; resolve returns the stored key; top-level `by` still means "LLM last saved" |
| `:144` | `TestTelegramSectionReplacesEnvAsAWhole` | saved section normalises `" 333 "`/`"  Helper   Lim "` → `333`/`Helper Lim`, `fromEnv=false`, `updated` set; env users/groups are **not** merged; an empty saved list allows nobody; `useEnv` deletes the key and env applies again |
| `:177` | `TestTelegramValidation` | table: `not a number`, `negative user`, `empty name`, `name 41`, `duplicate user`, `positive group`, `group not a number`, `duplicate group`, `duplicate name` (`ZY`/`zy`) → each a `*ValidationError`; the rejected inputs write **nothing** (`ErrNotFound`) |
| `:205` | `TestParseTelegramEnv` | `111=ZY,222, 333=Lim Ah Kow` → bare id becomes its own name; groups parsed; `FromEnv`; empty env → 0 users; `zy=ZY` errors and the message names `TELEGRAM_ALLOWED_IDS` |
| `:221` | `TestUnreadableFileFallsBackToEnv` | `{not json` → env model, telegram from env (never allow-all); hand-edited invalid telegram section also falls back; saving over an unreadable file works and keeps nothing from it |
| `:244` | `TestCacheAndTTL` | own save visible immediately; another writer's change invisible until `CacheTTL + 1s` with the injected clock, then visible |
| `:280` | `TestTelegramSaveRetriesOnConflictAndKeepsTheOtherWrite` | `conflictOnce` (`:265`) loses the first conditional put and writes `{"llm":{"model":"raced"}}` meanwhile; after the retry the file contains both `raced` and `telegram` |
| `:317` | `TestSlowReadDoesNotCacheOverASave` | `blockFirstGet` (`:296`) orders a slow read after a save; the old allowlist must not come back (user 1 gone, user 2 present) |

### `internal/settings/kind_test.go`

| Line | Test | Asserts |
|---|---|---|
| `:19` | `TestNoKindMeansOpenAI` | v1 file, current file and **no file** all resolve `kind=openai` (resolve and view); `thinkOnDemand` preserved |
| `:37` | `TestBadKindIsRejected` | `kind:"gpt"` → `*ValidationError` from both `Save` and `ForTest` |
| `:53` | `TestClaudeUsesTheFixedOrigin` | claude input with `https://evil.example/v1` → `ForTest` and `Save` use/save `https://api.anthropic.com`; the typed key is used; a hand-edited claude file cannot redirect it |
| `:81` | `TestSwitchToClaudeDropsAnotherHostsKey` | after saving a vMLX connection + key, switching to claude (no typed key) sends/drops no key: `ForTest` key `""`, resolve key `""`, `apiKeyEnc` gone from the file |
| `:105` | `TestSwitchFromAnthropicOpenAILayerKeepsTheKey` | key saved for `https://api.anthropic.com/v1/` is reused for claude (same origin) |
| `:125` | `TestEnvKeyGoesOnlyToItsOrigin` | env key (`https://env.example/v1`) not sent to claude; with `LLM_KIND=claude` + `LLM_BASE_URL=ClaudeOrigin` + `LLM_API_KEY` the claude connection and key resolve |
| `:150` | `TestTelegramSaveKeepsKind` | a telegram save keeps `kind=claude` and the stored key |
| `:164` | `TestClaudeBaseURLOverride` | `WithClaudeBaseURL("http://127.0.0.1:9999/")` → resolved baseUrl `http://127.0.0.1:9999` (trailing slash trimmed, whitespace trimmed, empty ignored) |
| `:174` | `TestVision` | openai default `vision=false`; saved `vision=true` survives in resolve and view; claude forces `vision=true` |
| `:196` | `TestStoredKeyStaysWithItsHost` | (1) URL-less-kind file with a vMLX key read under `LLM_KIND=claude`: baseUrl forced to the origin, key not used, `KeyFor` gives nothing; (2) a claude key saved for the real origin is not used when `WithClaudeBaseURL` points elsewhere, and is used again when reset — uses a runtime-encrypted token (`:199-201`) |
| `:243` | `TestKeyWithoutURLAndOneWarning` | a stored `apiKeyEnc` with no `baseUrl` is never used, the "belongs to another host" warning appears **once** across 5 resolves, and the next save drops the key |

### `internal/settings/checkin_test.go`

| Line | Test | Asserts |
|---|---|---|
| `:14` | `TestCheckinSetting` | default 09:30 on, chat `""`, `fromEnv`; env `off` + `-100` wins over the default; saving `" 7:05 "` → `07:05`, `fromEnv=false`, `by`, `On/7/5`; another service on the same store sees `07:05` (persistence, not cache); rejects `20:00`, `7`, chat `x`, chat `0`; `useEnv` restores `off` from env |
| `:56` | `TestCheckinUnreadableAndInvalid` | `failingGet` (`:50`) → `ResolveCheckin` returns an error and **not** the on-09:30 defaults; a hand-edited invalid section (`21:00` + chat `x`) falls back to the env setting and warns exactly once over 3 resolves |
| `:83` | `TestTwoWarningsEachOnce` | two different invalid sections alternating → each warning once, not per call |

### Outside the package (settings behaviour under the HTTP layer)

| Line | Test |
|---|---|
| `server_test.go:418` | `TestSettingsKeyNeverLeaks` (save/view/test/models/chat bodies + logs; `keySet`/`keyLast4`/`by`; empty keeps key; `clearKey` → env key) |
| `server_test.go:481` | `TestSettingsEnvFallbackAndBounds` (env fallback in the view; 400 for bad `baseUrl`/`model`/`kind`; corrupt file still 200) |
| `server_test.go:511` | `TestModelSwitchTakesEffectNextMessage` |
| `server_test.go:528` | `TestSettingsTestEndpoint` (probe ok/tool-call failure; testing does not save) |
| `server_test.go:647` | `TestTelegramAdmin` (view/save/400 on `-5`/`useEnv`) |
| `server_test.go:678` | `TestTelegramAdminCheckinStatus` |
| `server_test.go:715` | `TestCheckinSettingThroughTheAPI` (normalisation, 400s, `useEnv`, sections don't clobber each other) |
| `server_test.go:741` | `TestTelegramAdminNeverShowsToken` |
| `server_test.go:793` | `TestStoredKeyOnlyGoesToItsOwnEndpoint` (models/test never send the stored key to another host; a typed key is sent; GET models is not allowed; moving host without a key drops it) |
| `server_test.go:867` | `TestSettingsConflictHasItsOwnMessage` (409 without a `doc` field) |
| `claude_settings_test.go:54` | `TestClaudeKindThroughTheAPI` (`kind:"claude"` via models/test/save; page never sees the key; claude key not sent to the OpenAI endpoint; 400 on `kind:"gpt"`) — **removed in v2** |

---

## 7. Callers outside the package

| Caller | Members used |
|---|---|
| `internal/server/server.go:29` | `Settings *settings.Service` field on `Server` |
| `server.go:92-99` | routes `PUT /api/settings/checkin`, `PUT /api/settings/telegram`, `GET|PUT /api/settings/llm`, `POST /api/settings/llm/test`, `POST /api/settings/llm/models` |
| `server.go:197-212` | error mapping: `*settings.ValidationError` → 400 with `Msg`; `settings.ErrConflict` → 409 with a fixed message |
| `server.go:442` | chat: `Settings.Resolve(ctx)`, then `cfg.Streaming` (`:458`), `cfg.Model` |
| `server.go:486-500` | `View`, `Save(ctx, userOf(r), Input)` |
| `server.go:520-553` | `ForTest`, `cfg.Streaming = false`, `settings.KindClaude` for the vision flag |
| `server.go:574-605` | `Resolve`, `settings.KindClaude`/`KindOpenAI`, `ClaudeBaseURL()`, `KeyFor(ctx, cfg.BaseURL, in.APIKey)`, `cfg.TimeoutSec = 15` |
| `internal/server/admin.go:171` | `settings.TelegramView` inside `telegramView.allowlist` |
| `admin.go:182-213` | `ViewCheckin`, `ViewTelegram`, `SaveTelegram`, `SaveCheckin` |
| `internal/telegram/bot.go:29`, `:256`, `:421` | `Settings` field; `ResolveTelegram` (authorise: `UserName`, `GroupAllowed`); `Resolve` + `Streaming = false` |
| `internal/telegram/checkin.go:44-60`, `:344`, `:459`, `:444` | `ResolveTelegram`, `Checkin.ChatID/On/Hour/Minute`, `ResolveCheckin`, `settings.CheckinSetting` in the status view |
| `internal/telegram/docs.go:24` | `ResolveTelegram(ctx).Groups` |
| `internal/docs/summary.go:18,26` | `Settings.Resolve` → `llm.New` |
| `internal/agent/agent.go:102,147,181` | takes `cfg settings.LLM` (model, think, timeouts) |
| `internal/agent/doctools.go:38,43,161` | `cfg.Vision` gates the image tools |
| `internal/llm/llm.go:122` | `New(cfg)` branches on `settings.KindClaude` |
| `internal/llm/openai.go:36-150` | `BaseURL`, `APIKey` (Bearer + `x-api-key`), `Model`, `TimeoutSec`, `ThinkOnDemand`, key redaction |
| `internal/llm/claude.go:36-446` | `BaseURL`, `APIKey`, `Model`, `TimeoutSec`, `ThinkOnDemand` |
| `cmd/movin/main.go:96-102` | `NewService(store, c.LLM, c.SettingsSecret, log)` + `WithTelegramEnv(...).WithCheckinEnv(...).WithClaudeBaseURL(c.ClaudeBaseURL)`; warns when the secret is empty |
| `cmd/chateval/main.go:334-372` | `NewService`, `WithClaudeBaseURL`, `Resolve`, `SameOrigin`, `KindClaude`, `LLM` |
| `static/index.html:1002-1065` | consumes `claudeOrigin`, `keySet`, `keyLast4`, `keyFromEnv`, `canStoreKey` |

---

## 8. Config env vars (`internal/config/config.go`)

`env(k, d)` trims spaces and treats `""` as unset (`config.go:57-62`).

| Var | Where | Behaviour |
|---|---|---|
| `SETTINGS_SECRET` | `:73` | Fernet key (44-char padded base64 or 64-char hex); empty = keys cannot be stored |
| `LLM_KIND` | `:95-101` | default `openai`; `openai` or `claude` accepted, anything else → `LLM_KIND must be "openai" or "claude"` (fmt `%q`); `claude` also sets `LLM.BaseURL = LLM_CLAUDE_BASE_URL` |
| `LLM_BASE_URL` | `:89` | `strings.TrimRight(..., "/")` |
| `LLM_CLAUDE_BASE_URL` | `:90` | default `settings.ClaudeOrigin`, trailing slashes trimmed; test/stub override |
| `LLM_API_KEY` | `:102` | |
| `LLM_MODEL` | `:103` | |
| `LLM_STREAMING` | `:104-108` | `strconv.ParseBool` (`1,t,T,TRUE,true,True,0,f,F,FALSE,false,False`), error `LLM_STREAMING: <err>` |
| `LLM_THINK_ON_DEMAND` | `:109-113` | same, error `LLM_THINK_ON_DEMAND: <err>` |
| `TELEGRAM_ALLOWED_IDS` | `:120` | `id=name,id2` (see §4.1) |
| `TELEGRAM_ALLOWED_CHATS` | `:120` | negative IDs, comma-separated; error message prefixed `TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS: ` |
| `TELEGRAM_BOT_TOKEN` | `:119` | empty = bot off (not a settings field) |
| `CHECKIN_SCHEDULE` | `:114-121` | default `"09:30"`; validated twice: once alone (`CHECKIN_SCHEDULE: <err>`), then with the chat (`ParseCheckin(schedule, CHECKIN_CHAT)` → possible `CHECKIN_CHAT: <err>`) |
| `CHECKIN_CHAT` | `:121` | default `""` |
| `TZ` | `:79-84` | `time.LoadLocation`, default `Asia/Singapore`; check-in "HH:MM" is in this zone (not part of settings.json) |
| `S3_BUCKET`/`S3_PREFIX`/`AWS_REGION`/`S3_ENDPOINT_URL` | `:70-73` | where `settings.json` lives; `S3_PREFIX` trimmed of `/` |

`c.LLM` starts as a **copy** of `settings.Defaults`, so `TimeoutSec=600`,
`MaxToolRounds=5`, `Streaming=true` unless overridden. There is no env var for
`vision` (env default is `false`) and none for timeouts/rounds.

Config tests: `internal/config/config_test.go:11 TestCheckinSettings` (defaults,
`off` + chat, `CHECKIN_SCHEDULE`/`CHECKIN_CHAT` error prefixes, `20:00` rejected with
"before 20:00").

---

## 9. Traps for a TS port

1. **Byte format.** Go writes `JSON.stringify(raw, null, 2)`-like output but with
   (a) top-level keys sorted, (b) struct field order inside known sections, (c) no
   trailing newline, (d) every array/object element on its own line. During the
   side-by-side period both apps write the same object; a formatting difference is not
   a correctness bug but it churns the ETag and makes diff-based verification useless.
   Gate: save from TS, then re-save the same input from Go, and compare bytes.
2. **HTML escaping.** Go escapes `<`, `>`, `&`, U+2028, U+2029 everywhere, including
   inside raw sections it merely passes through. `JSON.stringify` does none of that.
   A TS writer must post-process string literals (or use a raw-preserving writer) or
   the file differs from Go's byte for byte.
3. **Raw passthrough is not a JSON.parse round-trip.** `internal/settings` keeps the
   *bytes* of unknown sections: numbers keep their literal form (`1e3` stays `1e3`,
   `0.10` stays `0.10`), and duplicate keys survive. `JSON.parse` → `JSON.stringify`
   normalises all of that. If byte-compatibility matters, either use a
   raw/preserving parser or accept the churn and document it; the tests that matter
   (`settings_test.go:103`) only assert semantic survival.
4. **Fernet details.** base64 **url-safe, padded** on output; Go's verifier accepts
   only that alphabet (plus skipped `\r\n`). Timestamp is **seconds** (not ms), 8-byte
   big-endian, and `ttl = 0` on decrypt means **no** expiry and **no** clock-skew
   check, so a token from 1985 verifies. AES-128-CBC with the *second* 16 bytes of the
   key; HMAC-SHA256 with the *first* 16 over `version||ts||iv||ciphertext`; PKCS#7
   padding always adds a full block when aligned. Node's
   `crypto.createCipheriv('aes-128-cbc', cryptKey, iv)` with default padding matches.
   Proof test: the vectors in `vendor/.../fernet-go/{verify,generate}.json`.
5. **Key decoding order.** 64 chars → hex first, then standard base64, then url-safe
   base64; exactly 32 bytes; **unpadded** secrets are rejected. `Buffer.from(s,
   'base64')` in Node silently accepts both alphabets and unpadded strings, so the
   acceptance set is wider than Go's — validate length/exactness explicitly.
6. **Time.** `updated`/`by` are `toISOString()` **minus milliseconds**:
   `2026-11-11T09:00:00Z` (Go `time.RFC3339` drops the fraction). Do not emit
   `…00.000Z`. Values are UTC (`t.UTC()`); always `Z`, never `+08:00`. `updated` is
   omitted when empty (v1 file has it; a fresh telegram/checkin section always sets
   it).
7. **`nil` vs empty.** Writes always emit `"users": []` / `"groups": []` /
   `"schema": 1`. In views, `users`/`groups` are `[]` (never `null`);
   `KeyLast4`, `Updated`, `By`, `Unreadable` disappear when empty (`omitempty`);
   `Checkin.Chat`/`Schedule`/`FromEnv` are always present; `telegram`/`checkin`
   sections disappear entirely on `useEnv`. `apiKeyEnc` disappears when there is no key.
8. **`keyLast4` is bytes, not code points** (`APIKey[len-4:]`), and only emitted when
   `len(APIKey) >= 8`. Don't use `.slice(-4)` on a JS string if you care about
   non-ASCII keys (in practice keys are ASCII).
9. **Origin comparison.** Reimplement `SameOrigin` with `new URL()` semantics but Go's
   acceptance rules: scheme+host (host includes an explicit port) compared
   case-insensitively; **no** default-port folding; invalid URL or empty host → false;
   `TrimSpace` first. `new URL('https://h:443')` keeps `:443`, so `host` comparison is
   fine, but Go's `url.Parse` accepts things `URL` rejects (and vice versa) — decide
   per case and test the two that matter (`https://api.anthropic.com` vs
   `https://api.anthropic.com/v1/`).
10. **Empty `LLM_BASE_URL` disables env-key binding** (`settings.go:355`). Keep it: it
    is load-bearing for tests and for the "no base URL configured" dev case.
11. **`Save` overwrites every non-key field** from the request (absent JSON fields
    become `false`/`""`). A partial PUT clears `streaming`/`thinkOnDemand`/`vision`.
12. **`ForTest` ignores the file** except for the key (via `KeyFor`) and uses the
    *input* flags verbatim; the server then forces `Streaming = false`.
13. **Two validation error classes.** Only `*ValidationError` is a 400; anything else
    (store failure, encrypt failure) is a 500 ("That change didn't save. Try again.").
    `ErrConflict` is a 409 with its own message and no `doc`.
14. **Warning dedup.** `warnOnce` keys on message + `fmt.Sprint(args...)`; the
    decryption warning is deliberately **not** deduped. Tests count log lines
    (`kind_test.go:268-270`, `checkin_test.go:76-78`, `:93-95`), so the port must emit
    one line per distinct detail and the exact substrings.
15. **The 30 s TTL is the only cross-replica freshness.** No polling/subscribe here.
    Do not "improve" it to always-read: `server_test.go:511` and
    `settings_test.go:244` depend on the semantics (own saves instantly visible,
    foreign writes delayed).
16. **`gen` counter anti-race.** A read that started before a save must not overwrite
    the cache (`settings_test.go:317`). Reproduce with a generation counter (or by
    re-checking after the await).
17. **`remove` of a section must still write `schema: 1`** (i.e. `useEnv` on a file
    that only has that section leaves `{"schema": 1}`).
18. **Log field names** (`by`, `kind`, `model`, `baseUrl`, `keyChanged`, `users`,
    `groups`, `useEnv`, `schedule`, `chat`, `err`, `savedFor`, `target`) are asserted
    indirectly by the leak tests; keep the messages verbatim, never include the key.

---

## 10. Behaviour summary for the ported API

| Go member | Port must expose |
|---|---|
| `Key` | `"settings.json"` |
| `NewService(store, env, secret, log)` | throws `SETTINGS_SECRET is not a valid Fernet key: …` on a bad secret; empty secret = no key storage |
| `SetClock`, `CacheTTL` | injectable clock + 30 s TTL |
| `WithTelegramEnv`, `WithCheckinEnv`, `WithClaudeBaseURL`, `ClaudeBaseURL` | env layer setters (v2 drops the Claude pair) |
| `Resolve` | never throws; env fallback on any read failure |
| `ResolveTelegram` | never throws; env fallback; invalid section → env |
| `ResolveCheckin` | **throws** `read settings.json: …` on a read failure |
| `View`, `ViewTelegram`, `ViewCheckin` | the three view shapes above |
| `Save`, `SaveTelegram`, `SaveCheckin` | (view, error); validation → `ValidationError`; lost race → `ErrConflict` |
| `ForTest` | resolved-but-not-saved connection |
| `KeyFor` | per-request key with origin binding |
| `SameOrigin`, `ParseTelegramEnv`, `ParseCheckin`, `Defaults`, `DefaultCheckin`, `Kind*`, `ClaudeOrigin`, `ErrConflict`, `ValidationError` | as specified |

---

## 11. What v2 changes (`plan.md:55-63` "Design · LLM", `plan.md:101` "T1.4")

The plan removes Claude support. Concretely, these Go behaviours are **not** ported:

| Go behaviour (reference) | v2 behaviour |
|---|---|
| `KindClaude`, `ClaudeOrigin`, `WithClaudeBaseURL`/`ClaudeBaseURL`, `LLM_CLAUDE_BASE_URL` (`settings.go:28,33,181-189`; `config.go:90,96-99`) | removed; one OpenAI-compatible connection only |
| `resolve` treats `kind:"claude"` as a live connection: forces `BaseURL = claudeOrigin`, `Vision = true`, and may decrypt/send the stored key (`settings.go:325-328`, `:330-341`) | a stored `llm.kind == "claude"` (only ever from an old v1 save) → **the whole stored `llm` section is ignored**: env `LLM_*` applies, the key is **never decrypted** and never sent. Nothing is rewritten on read (no save, no `updated` touch). View carries `legacyKind: "claude"`. |
| `View.claudeOrigin` (`settings.go:98-99`); UI `claudeOrigin()`/`targetURL()` (`static/index.html:1002-1003`) | removed from the view (T2.2: "the view has no `claudeOrigin`"); the view gains `legacyKind` (`legacyKind` should sit right after `kind`, before `baseUrl`, and be omitted when empty — the exact position is a v2 choice, but it must be stable) |
| `normalise` maps `kind:"claude"` to the fixed origin and accepts it (`settings.go:425-427`) | `Save`/`ForTest`/`models`/`test` reject `kind:"claude"` with **400** (message to be chosen in T2.2; Go's `kind must be openai or claude` must change) |
| `Save` can persist `kind:"claude"` (`settings.go:490-500`) | Save always writes `kind:"openai"`; the field set otherwise identical so a Go rollback loses nothing (`plan.md:38,59`) |
| `LLM_KIND=claude` is a valid start (`config.go:95-101`), and `LLM_KIND` may be `openai` | `LLM_KIND` may be unset or `openai`; `claude` **refuses to start** with a clear message; the env's `BaseURL` no longer switches to a Claude origin |
| `Vision` forced on for claude (`settings.go:325-328`, `ForTest` `:461`) | vision only from the save probe (`plan.md:61`) |
| `listModels` Anthropic special case (`server.go:584-587`), the Anthropic SDK path (`internal/llm/claude.go`, `llm.go:122-125`), `chateval -kind claude` (`cmd/chateval/main.go:348-370`) | removed |
| Tests: `kind_test.go:53,81,105,125(part),150,164,174(claude part),196` and `internal/server/claude_settings_test.go` | dropped or rewritten; keep the origin-binding tests that do not mention Claude (the vMLX/NAI case in `kind_test.go:243` and `server_test.go:418,481,793` are the core) |

Everything else in this spec is unchanged in v2 and must be ported exactly: the
Fernet scheme (so a Go-written `apiKeyEnc` still decrypts and a TS-written one is
still readable by a Go rollback), the raw-section read-modify-write with the ETag
guard and 4 attempts, unknown-section passthrough, the 30 s cache, the origin
binding for stored and env keys, telegram/check-in validation, messages, defaults,
and the view shapes.

T1.4's verification list (`plan.md:101`), restated against this spec: a Go-encrypted
key fixture decrypts (§2.4 — must be created; use the Fernet vectors meanwhile); a
`kind:"claude"` fixture resolves to the env connection with `legacyKind` set, its key
unused, and the file byte-identical after reading (§11, §3.2); saving writes
`kind:"openai"` and keeps telegram/check-in/unknown sections (§1.5, §3.5); a Go
re-save of the TS result loses nothing (§9.1-9.3); the origin-binding tests are
ported (§3.3); `LLM_KIND=claude` refuses to start (§8).
