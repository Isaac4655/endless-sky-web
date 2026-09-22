/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
// https://github.com/gzuidhof/coi-serviceworker
// This service worker intercepts all requests made by the page and injects
// the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers,
// which are required for SharedArrayBuffer / pthreads to work, but which
// static hosts like GitHub Pages don't let you set server-side.

// Change this line at the very top of coi-serviceworker.js:
let coepCredentialless = true;

let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then((clients) => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => true,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;

        if (n.serviceWorker && n.serviceWorker.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: coepDegrading ? false : coi.coepCredentialless(),
            });

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or
        // it could be that the current context is "inherently" coi.
        if (window.crossOriginIsolated !== false || !n.serviceWorker) {
            return;
        }

        if (!window.isSecureContext) {
            !coi.quiet && console.log("[coi] Deployment requires a secure context.");
            return;
        }

        // In some environments (e.g. Firefox private mode) serviceWorker.register() will
        // never resolve/reject, so we need to add a timeout to avoid hanging.
        const registrationPromise = coi.shouldRegister() ? n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("[coi] Registered service worker:", registration.scope);

                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("[coi] Reloading page to make use of updated service worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    coi.doReload();
                });

                // If the registration is active, but it's not controlling the page
                if (registration.active && !n.serviceWorker.controller) {
                    !coi.quiet && console.log("[coi] Reloading page to make use of service worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            }
        ) : Promise.resolve();

        if (coepDegrading) {
            !coi.quiet && console.log("[coi] Assuming the previous reload was due to the coepCredentialless setting, and the browser is caching an outdated (potentially failing) response. Attempting to fix by degrading coepCredentialless.");
        }
    })();
}
