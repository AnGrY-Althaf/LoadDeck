# LoadDeck — a graphical control center for k6

LoadDeck wraps the real [k6](https://grafana.com/docs/k6/) engine in a local web app. You get a
point-and-click way to **generate** test scripts, **run** them with live charts, and get
**reports** you can export or compare. k6 still does the load generation, so results stay
accurate and every script stays a normal k6 script you can also run from the CLI or CI.

```
┌──────────── Browser (GUI) ────────────┐      ┌──────── LoadDeck server (Node) ────────┐
│ Dashboard · Scripts · Generator       │ REST │ script store · generators · runner      │
│ Live run view · Reports · Compare     │ ◄──► │ spawns `k6 run --out json=…`, tails &   │
└───────────────────────────────────────┘ SSE  │ aggregates metrics live, writes reports │
                                               └──────────────┬──────────────────────────┘
                                                              │ spawn
                                                         ┌────▼────┐
                                                         │   k6    │ ──► your system under test
                                                         └─────────┘
```

## Quick start

Requirements: **k6** (`brew install k6`) and **Node.js 20+**.

```bash
npm install
```

```bash
npm start
```

Open **http://localhost:7700**.

You can try it safely against the bundled demo API (it slows down as load rises, so stress tests behave realistically):

```bash
npm run demo-target
```

Then run the pre-installed **“Demo shop — user journey”** script, or import
`http://localhost:3333/openapi.json` in the Generator.

## Features

### Workspace and test builder

The dashboard shows real run totals, API latency trends, and direct entry points for API, browser and hybrid tests. The shared interface includes light/dark themes, engine availability, keyboard focus indicators, and layouts for narrow screens. Test-type cards adapt the builder steps to the selected workload; browser-only tests have a journey/review flow with an optional AI assistant. Browser steps disable irrelevant inputs for the selected action, and the save/run action bar keeps the test name and workload summary together.

### AI generation (any provider)
- **Describe with AI** (Generator → Import): you describe the test in plain English, for example *“log in from a CSV of users, browse 3 products, add to cart, check out; ramp to 200 users over 5 minutes; p95 under 400ms”*. You can also give a base URL, paste or drop reference material (API docs, an OpenAPI spec, sample requests), or reuse the load profile and SLAs from the Load & SLAs step.
- The script streams into the editor. LoadDeck then checks it with `k6 inspect`. If k6 rejects it, the error goes back to the model, which fixes it (up to 3 attempts). You get a validated script plus a short list of assumptions to check. The selected test type also applies to AI generation. An execution-plan review sends missing browser scenarios, missing hybrid API load, missing thresholds and unguarded arrival-rate plans back through the repair loop. Successful inspection checks loading/options; a smoke run still needs to verify actual application behaviour.
- **Ask AI** (code editor): describe a change, for example *“add a checkout step and ramp to 300 VUs”*. The model rewrites the script, k6 validates it, and ⌘Z undoes it.
- **Pick the provider per generation.** The dropdown next to *Generate* lists every provider you've set up and remembers your last choice.

#### Supported providers (Settings → AI providers)

| Provider | Key from | Env var alternative |
|---|---|---|
| Anthropic Claude | console.anthropic.com | `ANTHROPIC_API_KEY` |
| OpenAI | platform.openai.com | `OPENAI_API_KEY` |
| Google Gemini | aistudio.google.com | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| NVIDIA NIM | build.nvidia.com | `NVIDIA_API_KEY` |
| Groq | console.groq.com | `GROQ_API_KEY` |
| OpenRouter | openrouter.ai (hundreds of models) | `OPENROUTER_API_KEY` |
| Mistral AI | console.mistral.ai | `MISTRAL_API_KEY` |
| DeepSeek | platform.deepseek.com | `DEEPSEEK_API_KEY` |
| Together AI | api.together.ai | `TOGETHER_API_KEY` |
| xAI Grok | console.x.ai | `XAI_API_KEY` |
| Ollama (local, free) | no key needed; runs on `localhost:11434` | — |
| Custom OpenAI-compatible | your gateway (Azure OpenAI, LM Studio, vLLM, LiteLLM, …) | `CUSTOM_AI_API_KEY` |

For each provider: paste the key, click **Load models** (this fetches the provider's live model list and also tests the key), pick a model, then **Save**. To make it the default, use **Save & make default**. Every provider has a **Base URL** (needed for the custom endpoint, and editable for a proxy) and a **Max output tokens** setting; if a model's limit is lower than the 8192 default, lower it there.

- Keys are kept server-side in `data/settings.json` (file mode 600) and never sent to the browser; the UI only shows the last 4 characters. Usage is billed to your key. The panel shows the provider, model and tokens used.
- Claude uses the official Anthropic SDK (default model Claude Opus 5.5, with adaptive thinking, high effort, and Anthropic's server-side refusal fallback). All other providers use the OpenAI-compatible Chat Completions API. Reasoning output (`reasoning_content`) shows under *Model reasoning*, and `<think>` blocks are stripped from the script.
- Script quality depends on the model you choose. Whichever you use, k6 validation catches syntax and loading errors, but you should still review the endpoints and payloads before a real run.

### Real browsers and hybrid tests

The Generator has three **Test type** choices:

- **API load** runs protocol requests and the existing load profiles.
- **Real browsers** runs concurrent Chromium users with isolated cookies and storage for every journey.
- **Hybrid** runs API load and a smaller browser cohort together, so the frontend is measured while the backend is busy. This follows [Grafana's hybrid testing approach](https://grafana.com/docs/k6/latest/using-k6-browser/recommended-practices/hybrid-approach-to-performance/).

In **Browser journey**, enter your application's Base URL, concurrent browser users, duration and LCP threshold. Add ordered **Navigate**, **Fill input**, **Click**, **Wait for visible** and **Check text** steps using CSS selectors. Start with a navigation. Relative navigation paths use the Base URL; absolute URLs are supported. Fill values such as `{{USERNAME}}` and `{{PASSWORD}}` read those exact environment variable names from the run dialog. API auth, headers, variables and CSV data do not automatically apply to browser steps.

Use current k6 with the built-in `k6/browser` module and install Chrome or Chromium on the **LoadDeck server machine**. If automatic discovery fails, start LoadDeck with `K6_BROWSER_EXECUTABLE_PATH=/absolute/path/to/chrome`. Runs are headless by default. Enable **Show browser windows** in the run dialog to watch the concurrent sessions on that machine. Start with 2–5 browser users and monitor CPU/memory before increasing them; browser users cost much more than API VUs. The builder accepts 1–100 browser users, which is an input limit, not a capacity guarantee.

Browser duration is independent of the API profile. Align their durations to measure the frontend throughout a hybrid test. Browser/hybrid runs require **Use script options**; changing their counts and durations belongs in the builder or editor so scenario browser settings are preserved.

Reports keep API and browser requests separate and show browser request failures, request latency, and available Web Vitals at p75 (LCP, FCP, CLS, INP and TTFB). INP requires qualifying interactions and may be absent. Browser checks and thresholds determine pass/fail, including a default p75 LCP threshold of 2500 ms. All browser metrics are also in the k6 summary and HTML/JSON exports. See [browser metric semantics](https://grafana.com/docs/k6/latest/using-k6-browser/metrics/). These metrics describe the tested browser environment; run enough journeys for meaningful percentiles.

### Script generation (Generator)
Import from any of these sources. Each one becomes an editable list of requests:

| Source | What you give it |
|---|---|
| **URL** | A single endpoint, to start simple |
| **cURL** | One or more commands (DevTools → Network → *Copy as cURL*) |
| **HAR recording** | A browser recording of a user journey (DevTools → Network → *Save all as HAR*). Static assets and third-party domains are filtered out, pages become groups, and the pauses between pages become think time |
| **OpenAPI / Swagger** | OpenAPI 3 or Swagger 2, JSON or YAML. Example payloads are generated from the schemas, path params become variables and auth schemes are detected. Write operations are imported disabled so you don't modify data by accident |
| **Postman** | Collection v2/v2.1. Folders become groups and `{{variables}}` are kept |

Then set up the test visually:
- **Requests**: method, URL, headers, JSON/form/text body, expected status, max-duration and body-contains checks, a per-endpoint p95 SLA and think time. **Extract values** from responses (JSON path, header or regex) and reuse them later as `{{name}}`, for example a login token.
- **Load profiles**: Smoke, Average load, Stress (4 steps), Spike, Soak, Breakpoint (auto-aborts), Constant arrival rate, Fixed iterations or Custom stages. A live preview chart shows the load shape and the planned duration.
- **SLAs / thresholds**: p95, p99, error rate and check pass rate. These decide whether a run passes or fails.
- **Data & auth**: Bearer, Basic or API-key auth; default headers; variables that can be overridden at run time with `-e NAME=value`; built-ins such as `{{$uuid}}` and `{{$timestamp}}`; and CSV test data (sequential, random or one row per VU) embedded via `SharedArray`.
- **Script preview**: shows readable, commented k6 code, which you can validate with `k6 inspect` before saving.

Generated scripts remember how they were built, so **Scripts → Builder** re-opens them in the generator.

### Script editor
A code editor with k6 snippets (groups, POST JSON, setup/login, custom metrics, arrival-rate
scenarios, batch requests and more), **Validate** (`k6 inspect`), and ⌘S to save.

### Running tests
- Run with the script's own options, or override them per run: VUs + duration, ramping stages or fixed iterations. You can also set environment variables (`-e`), tags (`--tag`) and full HTTP debug logging.
- The **live view** shows VUs, requests/s, p95/avg latency, error rate and checks updating every second, plus 4 live charts and the k6 console (including `console.log` from your script).
- **Stop** shuts k6 down gracefully, so you still get a report. Press it again to force-kill.
- Several runs can go at once (the limit is in Settings), and each run keeps a snapshot of the exact script it used.

### Reports
- You get a pass/fail verdict, summary tiles, and **Key findings**, an automatic analysis of error-rate problems, when errors started (and at how many VUs), latency degradation, **throughput saturation**, the slowest and most failing endpoints, and failing checks.
- Threshold results with the actual values.
- Charts over time: VUs, throughput, response time (avg/p95/p99) and errors.
- A sortable per-endpoint table (count, req/s, errors, avg/med/p90/p95/p99/max, status codes), plus status-code distribution, checks, top errors and the full k6 metric table.
- **Export**: a self-contained **HTML report** (opens offline and can be emailed or attached to a ticket), **CSV** (endpoints + per-second series), **JSON**, or the raw k6 summary.
- **Compare** two runs (baseline vs candidate): metric deltas marked better/worse, overlaid charts, a per-endpoint p95 diff and a regression verdict. Mark a run with ★ to make it the baseline.
- The dashboard has a **p95 trend across runs** per script, for spotting regressions over time.

## How it stays efficient
- Metrics are aggregated **while k6 runs**, streamed from k6's JSON output. Latencies go into
  log-bucketed histograms (~1% precision), so memory stays flat even for hour-long soak tests.
  Uninteresting metric lines are skipped before JSON parsing.
- The raw per-request stream is deleted after the report is built. Turn on *Keep raw data* in Settings
  if you want it.
- Completed overall API latency and throughput use the **exact k6 summary**, rather than histogram estimates. Browser aggregates also use k6's exact summary. Live and per-endpoint percentiles remain histogram estimates; small samples can differ from k6's interpolated percentiles.
- Failure counts use k6's failure-rate samples. Arrival-rate tests include a `dropped_iterations == 0` threshold, and reports flag dropped journeys so insufficient VUs or generator resources cannot silently look like successful capacity delivery.
- Arrival rate means **journeys/iterations per second**. A journey containing five API requests at 20 iterations/s can issue approximately 100 requests/s; it is not a promise of 20 requests/s.
- Every run is inspected before execution, with its environment variables. Displayed/exported command lines redact `-e` values. Run configuration files still retain the supplied environment values; treat the local data directory as sensitive.

## Data & files

```
data/
  scripts/<id>.js + <id>.json       your scripts (+ generator definition)
  runs/<id>/meta.json               status, config, headline numbers
  runs/<id>/report.json             full aggregated report
  runs/<id>/summary.json            k6 --summary-export
  runs/<id>/stdout.log              k6 output
  runs/<id>/script.js               exact script used
  settings.json
```

Everything is plain files: back it up, put it in git or delete runs by removing folders.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `7700` | GUI/API port |
| `HOST` | `127.0.0.1` | Bind address. Keep it local: anyone who can reach LoadDeck can run k6 scripts on this machine |
| `LOADDECK_DATA` | `./data` | Where scripts and runs are stored |
| `DEMO_PORT` | `3333` | Port of the demo target API |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, … | — | AI provider keys (alternative to Settings → AI providers; a key saved in Settings wins) |

The k6 binary path, the concurrent-run limit and raw-data retention are set in **Settings** in the app.

## Tips for meaningful results
- Start with a **Smoke** profile to verify the script, then move to load → stress.
- Always set **thresholds**. They turn a run into a clear pass/fail.
- Name requests (the generator does this) so dynamic URLs like `/products/123` are grouped in reports.
- For accurate numbers, don't run several heavy tests at once on the same machine, and watch the load
  generator's own CPU. If k6 is CPU-bound, the latencies it reports go up.
- Use **Compare** against a ★ baseline after each release.

## Project layout

```
server/index.js            HTTP server + REST API
server/runner.js           k6 process management, live tailing, SSE
server/aggregator.js       streaming metrics aggregation (histograms, per-second series)
server/report.js           standalone HTML / CSV export
server/generator/builder.js    test definition → k6 script
server/generator/browser.js    browser journey validation and code generation
server/generator/quality.js    AI execution-plan review
server/summary.js          exact k6 summary reconciliation
server/generator/importers.js  cURL, HAR, OpenAPI, Postman importers
server/generator/ai.js     AI generation loop: prompt, k6 validation, repair
server/generator/providers.js  provider registry: Anthropic SDK + OpenAI-compatible adapter
public/                    the GUI (vanilla JS, Chart.js, CodeMirror — no build step)
public/js/report-view.js   report renderer shared by the app and HTML export
demo/target-server.js      demo API for practice
examples/                  example k6 scripts
```

## Validation

```bash
npm test                  # metric accuracy, browser generation, AI plan repair
npm run test:integration  # real k6 API, browser and hybrid tests against a local fixture
```

Integration tests require k6 and Chrome/Chromium; they skip if k6 is missing. They use temporary data directories, verify concurrent browser navigation, exercise fill/click/text checks and report exports, and do not send load to external applications. The AI repair test uses a local mock provider; it does not spend API credits or measure the quality of a live model.

## Suggested next investments

For the development team, add browser journey recording with reviewed selectors, weighted business flows (browse/search/checkout), and CI regression budgets against a baseline. For the server team, connect Prometheus/Grafana metrics (CPU, memory, database connections, queue depth, autoscaling events) to the run timeline. Request latency alone cannot identify which server resource caused a bottleneck. For traffic beyond one load generator's capacity, add distributed workers with synchronized starts and a shared run report.

These integrations are future work. The current application runs local k6 processes and measures requests/browser behaviour; it does not collect remote server CPU or database metrics.
