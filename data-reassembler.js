/*
 * data-reassembler.js (Fixed)
 */

(function () {
    const PART_DIR = "data/";
    const PART_PREFIX = "endless-sky.data.part";
    const PART_COUNT = 16;
    const PART_DIGITS = 2;

    async function fetchAndAssembleData(originalUrl) {
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

        xhr.open = function (method, url, ...rest) {
            // FIX: Use regex here as well
            if (url && /endless-sky\.data(\?.*)?$/.test(url)) {
                console.log("[data-reassembler] Intercepting XHR for", url, "- reassembling from", PART_COUNT, "parts");

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
