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

        const partPromises = [];
        for (let i = 0; i < PART_COUNT; i++) {
            const url = base + PART_DIR + PART_PREFIX + String(i).padStart(PART_DIGITS, "0");
            partPromises.push(
                fetch(url).then((res) => {
                    if (!res.ok) {
                        reportPartDone(i, 0, false, "HTTP " + res.status + " for " + url);
                        throw new Error("Failed to fetch data part " + i + " (" + url + "): " + res.status);
                    }
                    return res.arrayBuffer();
                }).then((buf) => {
                    reportPartDone(i, buf.byteLength, true);
                    return buf;
                }, (err) => {
                    reportPartDone(i, 0, false, err.message || String(err));
                    throw err;
                })
            );
        }

        const parts = await Promise.all(partPromises);

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

        console.log("[data-reassembler] Assembly complete: " + totalLength + " bytes ready.");

        return new Response(combined.buffer, {
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
            return fetchAndAssembleData(url);
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
