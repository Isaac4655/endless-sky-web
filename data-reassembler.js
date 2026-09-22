/*
 * data-reassembler.js (Fixed)
 */

(function () {
    const PART_DIR = "data/";
    const PART_PREFIX = "endless-sky.data.part";
    const PART_COUNT = 16;
    const PART_DIGITS = 2;

    async function fetchAndAssembleData(originalUrl, onProgress) {
        const base = originalUrl.replace(/endless-sky\.data(\?.*)?$/, "");

        let completed = 0;
        const statusEl = document.getElementById("status");

        function reportPartDone(i, byteLength, ok, err) {
            completed++;
            const msg = ok
                ? "[data-reassembler] Got part " + i + " (" + byteLength + " bytes) \u2014 " + completed + "/" + PART_COUNT + " done"
                : "[data-reassembler] FAILED part " + i + ": " + err;
            if (ok) {
                console.log(msg);
            } else {
                console.error(msg);
            }
            if (statusEl) {
                statusEl.innerText = "Downloading data: " + completed + "/" + PART_COUNT + " parts";
            }
        }

        async function fetchPart(i) {
            const url = base + PART_DIR + PART_PREFIX + String(i).padStart(PART_DIGITS, "0");
            const MAX_ATTEMPTS = 4;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const controller = new AbortController();
                const perPartTimeout = setTimeout(() => {
                    console.error("[data-reassembler] Part " + i + " (attempt " + attempt + ") timed out after 30s — aborting: " + url);
                    controller.abort();
                }, 30000);

                try {
                    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
                    clearTimeout(perPartTimeout);
                    if (!res.ok) {
                        throw new Error("HTTP " + res.status + " for " + url);
                    }
                    const buf = await res.arrayBuffer();
                    reportPartDone(i, buf.byteLength, true);
                    return buf;
                } catch (err) {
                    clearTimeout(perPartTimeout);
                    const willRetry = attempt < MAX_ATTEMPTS;
                    console.error(
                        "[data-reassembler] Part " + i + " attempt " + attempt + "/" + MAX_ATTEMPTS +
                        " failed: " + (err.message || err) +
                        (willRetry ? " — retrying..." : " — giving up.")
                    );
                    if (!willRetry) {
                        reportPartDone(i, 0, false, err.message || String(err));
                        throw err;
                    }
                    // Exponential backoff before retrying: 500ms, 1s, 2s...
                    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
                }
            }
        }

        // Fetch with bounded concurrency instead of firing all 16 requests at once.
        // GitHub Pages (and browsers generally) throttle/limit concurrent requests
        // per origin, and pushing too many large parts at once can cause outright
        // connection failures ("Failed to fetch"), not just slowness.
        const CONCURRENCY = 2;
        const results = new Array(PART_COUNT);
        let nextIndex = 0;

        async function worker() {
            while (nextIndex < PART_COUNT) {
                const i = nextIndex++;
                results[i] = await fetchPart(i);
            }
        }

        const workers = [];
        for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
        await Promise.all(workers);

        const parts = results;

        let totalLength = 0;
        for (const p of parts) totalLength += p.byteLength;

        console.log("[data-reassembler] All " + PART_COUNT + " parts fetched, total " + totalLength + " bytes. Assembling...");

        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const p of parts) {
            combined.set(new Uint8Array(p), offset);
            offset += p.byteLength;
            if (typeof onProgress === "function") {
                onProgress(offset, totalLength);
            }
        }

        console.log("[data-reassembler] Assembly complete: " + totalLength + " bytes ready. Handing off as a stream...");

        // Build the Response body as an explicit ReadableStream we fully control,
        // rather than relying on the runtime to convert a raw ArrayBuffer into a
        // lazily-streamed body. This guarantees the consumer's
        // `response.body.getReader().read()` loop sees exactly one chunk and a
        // clean `done: true` afterwards, instead of potentially hanging.
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(combined);
                controller.close();
                console.log("[data-reassembler] Stream closed after enqueueing " + totalLength + " bytes.");
            }
        });

        return new Response(body, {
            status: 200,
            statusText: "OK",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(totalLength),
            },
        });
    }

    const originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url ? input.url : "");

        // FIX: Use regex to match endless-sky.data even if query parameters are attached
        if (url && /endless-sky\.data(\?.*)?$/.test(url)) {
            console.log("[data-reassembler] Intercepting fetch for", url, "- reassembling from", PART_COUNT, "parts");

            const watchdog = setTimeout(() => {
                console.error("[data-reassembler] WATCHDOG: still assembling after 90s. If you see repeated retry messages above this is expected to take a while on a slow connection; otherwise something is stuck.");
            }, 90000);

            return fetchAndAssembleData(url).then((response) => {
                clearTimeout(watchdog);
                console.log("[data-reassembler] Returning assembled Response to caller.");
                return response;
            }).catch((err) => {
                clearTimeout(watchdog);
                console.error("[data-reassembler] fetchAndAssembleData failed:", err);
                throw err;
            });
        }

        return originalFetch(input, init);
    };

    const OriginalXHR = window.XMLHttpRequest;

    function PatchedXHR() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open.bind(xhr);
        const originalAddEventListener = xhr.addEventListener.bind(xhr);

        // Emscripten's data loader may attach listeners via addEventListener
        // instead of (or in addition to) xhr.onload/.onprogress. Track both
        // so our synthetic events reach whichever style it uses.
        const listeners = { progress: [], load: [], loadend: [], error: [], readystatechange: [] };
        xhr.addEventListener = function (type, listener, opts) {
            if (xhr._isIntercepted && listeners[type]) {
                listeners[type].push(listener);
                return;
            }
            return originalAddEventListener(type, listener, opts);
        };

        function fire(type, evt) {
            listeners[type].forEach((fn) => {
                try { fn(evt); } catch (e) { console.error("[data-reassembler] listener error:", e); }
            });
            const handlerName = "on" + type;
            if (typeof xhr[handlerName] === "function") {
                try { xhr[handlerName](evt); } catch (e) { console.error("[data-reassembler] handler error:", e); }
            }
            xhr.dispatchEvent(new Event(type));
        }

        function setReadyState(state) {
            Object.defineProperty(xhr, "readyState", { value: state, configurable: true });
            fire("readystatechange", { target: xhr });
        }

        xhr.open = function (method, url, ...rest) {
            // FIX: Use regex here as well
            if (url && /endless-sky\.data(\?.*)?$/.test(url)) {
                console.log("[data-reassembler] Intercepting XHR for", url, "- reassembling from", PART_COUNT, "parts");

                xhr._interceptedUrl = url;
                xhr._isIntercepted = true;
                Object.defineProperty(xhr, "responseType", { value: "arraybuffer", configurable: true, writable: true });

                setReadyState(1); // OPENED

                xhr.send = function () {
                    setReadyState(2); // HEADERS_RECEIVED (close enough for loaders that gate on this)
                    setReadyState(3); // LOADING

                    fetchAndAssembleData(url, (loaded, total) => {
                        fire("progress", { target: xhr, lengthComputable: true, loaded, total });
                    })
                        .then((response) => response.arrayBuffer())
                        .then((buffer) => {
                            Object.defineProperty(xhr, "status", { value: 200, configurable: true });
                            Object.defineProperty(xhr, "statusText", { value: "OK", configurable: true });
                            Object.defineProperty(xhr, "response", { value: buffer, configurable: true });

                            fire("progress", { target: xhr, lengthComputable: true, loaded: buffer.byteLength, total: buffer.byteLength });
                            setReadyState(4); // DONE
                            fire("load", { target: xhr });
                            fire("loadend", { target: xhr });
                            console.log("[data-reassembler] XHR delivered", buffer.byteLength, "bytes to Emscripten loader.");
                        })
                        .catch((err) => {
                            console.error("[data-reassembler] XHR reassembly failed:", err);
                            Object.defineProperty(xhr, "status", { value: 0, configurable: true });
                            setReadyState(4);
                            fire("error", { target: xhr });
                            fire("loadend", { target: xhr });
                        });
                };
                return; // suppress the real open()
            }
            return originalOpen(method, url, ...rest);
        };

        return xhr;
    }

    window.XMLHttpRequest = PatchedXHR;
})();
