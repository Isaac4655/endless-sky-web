/* Endless Sky Web COI bootstrap.
 *
 * Cross-origin isolation is required by the pthread build of Endless Sky.
 * This file works as both:
 *   1. a small page-side bootstrap that registers/activates the service worker, and
 *   2. the service worker itself, which injects COOP/COEP/Permissions-Policy headers.
 *
 * For static hosts such as GitHub Pages, the service-worker header injection is
 * the fallback because the host does not let the site author set HTTP headers.
 *
 * COEP deliberately uses "require-corp" rather than "credentialless". This is
 * the more conservative choice for Safari/WebKit compatibility and is suitable
 * here because the Endless Sky web build serves its application resources from
 * the same origin.
 */
(() => {
    const VERSION = "endless-sky-coi-v2";
    const RELOAD_KEY = "__esCoiReloadCount";
    const MAX_RELOADS = 2;

    // Service-worker context: no window/document exists.
    if (typeof window === "undefined") {
        self.addEventListener("install", event => {
            event.waitUntil(self.skipWaiting());
        });

        self.addEventListener("activate", event => {
            event.waitUntil(self.clients.claim());
        });

        self.addEventListener("fetch", event => {
            const request = event.request;

            // Required for Firefox/cache semantics: don't respond to a cross-origin
            // only-if-cached request from a service worker.
            if (request.cache === "only-if-cached" && request.mode !== "same-origin")
                return;

            event.respondWith((async () => {
                const response = await fetch(request);

                // Opaque responses cannot have their headers/body reconstructed.
                if (response.type === "opaque" || response.status === 0)
                    return response;

                const headers = new Headers(response.headers);

                headers.set("Cross-Origin-Opener-Policy", "same-origin");
                headers.set("Cross-Origin-Embedder-Policy", "require-corp");
                headers.set("Permissions-Policy", "cross-origin-isolated=(self)");

                // Same-origin resources are already eligible under COEP. Supplying
                // CORP explicitly makes their intent unambiguous to browsers and
                // helps with embedded worker/resource edge cases.
                try {
                    if (new URL(request.url).origin === self.location.origin)
                        headers.set("Cross-Origin-Resource-Policy", "same-origin");
                } catch (_) {
                    // If URL parsing somehow fails, keep the original headers.
                }

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
            })());
        });

        return;
    }

    const currentScript = document.currentScript;
    const state = {
        version: VERSION,
        secureContext: window.isSecureContext === true,
        serviceWorkerSupported: "serviceWorker" in navigator,
        crossOriginIsolated: window.crossOriginIsolated === true,
        sharedArrayBufferSupported: typeof window.SharedArrayBuffer === "function",
        atomicsSupported: typeof window.Atomics === "object"
            && typeof window.Atomics.wait === "function"
    };

    window.__endlessSkyCOI = state;

    function publish(ok, reason) {
        state.ok = !!ok;
        state.reason = reason || "";
        window.__endlessSkyCOI = state;
        if (typeof window.dispatchEvent === "function")
            window.dispatchEvent(new CustomEvent("endless-sky-coi", { detail: state }));
        return !!ok;
    }

    // The headers may already be supplied by the real web server/CDN. In that
    // case, service-worker registration is unnecessary and only adds complexity.
    if (state.crossOriginIsolated && state.sharedArrayBufferSupported) {
        try {
            sessionStorage.removeItem(RELOAD_KEY);
        } catch (_) {}
        window.__endlessSkyCOIReady = Promise.resolve(publish(true, "Server-provided COI is active."));
        return;
    }

    async function waitForController() {
        if (navigator.serviceWorker.controller)
            return true;

        return new Promise(resolve => {
            let done = false;
            const finish = value => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                navigator.serviceWorker.removeEventListener("controllerchange", onChange);
                resolve(value);
            };
            const onChange = () => finish(true);
            const timer = setTimeout(() => finish(!!navigator.serviceWorker.controller), 2500);

            navigator.serviceWorker.addEventListener("controllerchange", onChange, { once: true });
        });
    }

    async function bootstrap() {
        if (!state.secureContext) {
            return publish(false,
                "Cross-origin isolation requires HTTPS (or localhost).");
        }

        if (!state.serviceWorkerSupported) {
            return publish(false,
                "This browser does not support Service Workers. Serve the site over HTTPS or use a browser with Service Worker support.");
        }

        if (!currentScript || !currentScript.src) {
            return publish(false,
                "The COI service worker script could not determine its own URL.");
        }

        let reloadCount = 0;
        try {
            reloadCount = Number.parseInt(sessionStorage.getItem(RELOAD_KEY) || "0", 10) || 0;
        } catch (_) {
            reloadCount = 0;
        }

        if (reloadCount > MAX_RELOADS) {
            return publish(false,
                "Cross-origin isolation did not become active after multiple reloads. Check the browser's Service Worker settings and site headers.");
        }

        try {
            const scriptURL = new URL(currentScript.src, document.baseURI).href;
            const scopeURL = new URL("./", scriptURL).href;

            const registration = await navigator.serviceWorker.register(scriptURL, {
                scope: scopeURL,
                updateViaCache: "none"
            });

            // Make a new SW version take effect quickly without waiting for the
            // browser's normal update interval.
            try {
                await registration.update();
            } catch (_) {
                // A failed update is not fatal when an existing active worker exists.
            }

            await navigator.serviceWorker.ready;

            if (!navigator.serviceWorker.controller) {
                await waitForController();
            }

            // A service worker can be installed but not have controlled the
            // document that loaded it yet. A navigation is needed for the COOP/
            // COEP response headers to apply to the document itself.
            if (!window.crossOriginIsolated || !window.SharedArrayBuffer) {
                try {
                    sessionStorage.setItem(RELOAD_KEY, String(reloadCount + 1));
                } catch (_) {}

                window.location.reload();
                return false;
            }

            try {
                sessionStorage.removeItem(RELOAD_KEY);
            } catch (_) {}

            return publish(true,
                `Cross-origin isolation active via service worker (${registration.scope}).`);
        } catch (error) {
            console.error("[COI] Service worker bootstrap failed:", error);
            return publish(false,
                "The COI service worker could not be installed. The site must be HTTPS/localhost and Service Workers must be allowed.");
        }
    }

    window.__endlessSkyCOIReady = bootstrap();
})();
