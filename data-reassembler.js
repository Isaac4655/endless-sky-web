/*
 * data-reassembler.js
 *
 * endless-sky.js expects to fetch a single file called "endless-sky.data".
 * Because that file is too large for a normal GitHub push, it has been split
 * into 16 raw binary chunks living in data/endless-sky.data.part00 ... part15.
 *
 * This script patches window.fetch so that any request whose URL ends in
 * "endless-sky.data" is transparently redirected: it fetches all 16 parts,
 * concatenates them in order into a single ArrayBuffer, and returns a
 * synthetic Response built from that buffer - indistinguishable to
 * endless-sky.js's loader from a normal single-file fetch.
 *
 * Must be loaded BEFORE endless-sky.js.
 */

(function () {
    const PART_DIR = "data/";
    const PART_PREFIX = "endless-sky.data.part";
    const PART_COUNT = 16; // part00 .. part15
    const PART_DIGITS = 2; // "00", "01", ... "15"

    function partUrl(index) {
        const n = String(index).padStart(PART_DIGITS, "0");
        return PART_DIR + PART_PREFIX + n;
    }

    async function fetchAndAssembleData(originalUrl) {
        // Preserve any path prefix the original request had, in case
        // endless-sky.js is served from a subdirectory.
        const base = originalUrl.replace(/endless-sky\.data(\?.*)?$/, "");

        const partPromises = [];
        for (let i = 0; i < PART_COUNT; i++) {
            const url = base + PART_DIR + PART_PREFIX + String(i).padStart(PART_DIGITS, "0");
            partPromises.push(
                fetch(url).then((res) => {
                    if (!res.ok) {
                        throw new Error("Failed to fetch data part " + i + " (" + url + "): " + res.status);
                    }
                    return res.arrayBuffer();
                })
            );
        }

        const parts = await Promise.all(partPromises);

        let totalLength = 0;
        for (const p of parts) totalLength += p.byteLength;

        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const p of parts) {
            combined.set(new Uint8Array(p), offset);
            offset += p.byteLength;
        }

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
        const url = typeof input === "string" ? input : input.url;

        if (url && url.endsWith("endless-sky.data")) {
            console.log("[data-reassembler] Intercepting fetch for", url, "- reassembling from", PART_COUNT, "parts");
            return fetchAndAssembleData(url);
        }

        return originalFetch(input, init);
    };

    // Emscripten's loader can also use XMLHttpRequest instead of fetch,
    // depending on build settings. Patch that path too as a safety net.
    const OriginalXHR = window.XMLHttpRequest;

    function PatchedXHR() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open.bind(xhr);

        xhr.open = function (method, url, ...rest) {
            if (url && url.endsWith("endless-sky.data")) {
                console.log("[data-reassembler] Intercepting XHR for", url, "- reassembling from", PART_COUNT, "parts");

                // Swap this XHR instance's behavior: fetch+assemble the data,
                // then fake out the readyState/response fields and events
                // that Emscripten's XHR-based loader listens for.
                xhr._interceptedUrl = url;
                xhr._isIntercepted = true;

                const fakeOpen = function () {};
                xhr.send = function () {
                    fetchAndAssembleData(url)
                        .then((response) => response.arrayBuffer())
                        .then((buffer) => {
                            Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
                            Object.defineProperty(xhr, "status", { value: 200, configurable: true });
                            Object.defineProperty(xhr, "response", { value: buffer, configurable: true });
                            Object.defineProperty(xhr, "responseType", { value: "arraybuffer", configurable: true });
                            if (typeof xhr.onload === "function") xhr.onload();
                            xhr.dispatchEvent(new Event("load"));
                            xhr.dispatchEvent(new Event("loadend"));
                        })
                        .catch((err) => {
                            console.error("[data-reassembler] XHR reassembly failed:", err);
                            if (typeof xhr.onerror === "function") xhr.onerror(err);
                            xhr.dispatchEvent(new Event("error"));
                        });
                };
                return fakeOpen();
            }
            return originalOpen(method, url, ...rest);
        };

        return xhr;
    }

    window.XMLHttpRequest = PatchedXHR;
})();
