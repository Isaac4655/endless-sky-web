// idbfs-persist.js
//
// Endless Sky's config/save/preferences directory (Files::Config(), and
// everything under it: saves/, pilots/, plugins/) is resolved at runtime via
// SDL_GetPrefPath(nullptr, "endless-sky"). On the Emscripten SDL2 port,
// SDL_GetPrefPath() always creates its directory under a single fixed parent,
// "/libsdl/", regardless of the org/app suffix -- so mounting persistent
// storage there, rather than at the full computed path, means this keeps
// working even if the org/app naming ever changes.
//
// ---------------------------------------------------------------------------
// Storage model (replaces the old IndexedDB-backed IDBFS approach)
// ---------------------------------------------------------------------------
// Previously this file mounted IDBFS over "/libsdl" with autoPersist, so
// every write went straight into this origin's IndexedDB. That worked, but
// it meant save data was physically part of the website's storage: clearing
// site data (which this game occasionally requires players to do to recover
// from a broken state) wiped every save along with it, and saves couldn't be
// backed up, moved, or inspected like normal files.
//
// Now "/libsdl" is a plain in-memory MEMFS directory, and a real directory
// on the player's own disk -- chosen once via the File System Access API --
// is kept in sync with it:
//
//   - On first run (or whenever no directory is remembered, or the
//     remembered one can no longer be used), the player is asked to pick a
//     folder. That folder's handle is stored in IndexedDB (handles are
//     structured-cloneable) under a fixed key, purely as a pointer -- no
//     save data lives in IndexedDB anymore.
//   - On every later run, the remembered handle is reused. The browser
//     requires a user gesture to re-grant permission on a handle from a
//     previous session, so if silent permission isn't already granted, a
//     small "click to resume" prompt is shown first.
//   - Before main() starts, every file under the chosen folder is copied
//     into MEMFS at "/libsdl", exactly like the old initial IndexedDB->MEMFS
//     sync.
//   - After that, local writes are mirrored out to the real folder shortly
//     after they happen (debounced), and also flushed on tab hide/unload,
//     so the on-disk copy stays current without writing to disk on every
//     single byte written in C++.
//
// Because the saves now live as ordinary files in a folder the player
// chose, a full "reset the site" (clearing this origin's storage, including
// IndexedDB) no longer touches them. It only forgets *which* folder was
// chosen, and the player is asked to pick it again -- and since the browser
// remembers the player's permission grant per folder+origin for a while, in
// practice this is usually a single click, not a re-pick of the actual
// path. The chosen folder is also a completely ordinary place on their
// disk, so they can open it, back it up, or copy it to another machine like
// any other files.
//
// This file has no dependency on any particular page markup: it builds its
// own minimal overlay UI on demand and injects the small amount of CSS it
// needs, so it can be dropped into any Emscripten shell unchanged.

(function()
{
	"use strict";

	const MOUNT_PATH = "/libsdl";
	const DB_NAME = "endless-sky-save-location";
	const DB_STORE = "handles";
	const DB_KEY = "saveDirectory";
	const SYNC_DEBOUNCE_MS = 1500;

	// ---------------------------------------------------------------------
	// Small helpers: a promise-based wrapper around the one IndexedDB
	// object store we use to remember the chosen directory handle.
	// ---------------------------------------------------------------------

	function openHandleDb()
	{
		return new Promise(function(resolve, reject)
		{
			const request = indexedDB.open(DB_NAME, 1);
			request.onupgradeneeded = function()
			{
				request.result.createObjectStore(DB_STORE);
			};
			request.onsuccess = function() { resolve(request.result); };
			request.onerror = function() { reject(request.error); };
		});
	}

	async function loadStoredHandle()
	{
		try
		{
			const db = await openHandleDb();
			return await new Promise(function(resolve, reject)
			{
				const tx = db.transaction(DB_STORE, "readonly");
				const req = tx.objectStore(DB_STORE).get(DB_KEY);
				req.onsuccess = function() { resolve(req.result || null); };
				req.onerror = function() { reject(req.error); };
			});
		}
		catch(error)
		{
			console.error("[SaveDir] Could not read remembered save folder:", error);
			return null;
		}
	}

	async function storeHandle(handle)
	{
		try
		{
			const db = await openHandleDb();
			await new Promise(function(resolve, reject)
			{
				const tx = db.transaction(DB_STORE, "readwrite");
				tx.objectStore(DB_STORE).put(handle, DB_KEY);
				tx.oncomplete = resolve;
				tx.onerror = function() { reject(tx.error); };
			});
		}
		catch(error)
		{
			console.error("[SaveDir] Could not remember chosen save folder:", error);
		}
	}

	async function clearStoredHandle()
	{
		try
		{
			const db = await openHandleDb();
			await new Promise(function(resolve, reject)
			{
				const tx = db.transaction(DB_STORE, "readwrite");
				tx.objectStore(DB_STORE).delete(DB_KEY);
				tx.oncomplete = resolve;
				tx.onerror = function() { reject(tx.error); };
			});
		}
		catch(error)
		{
			console.error("[SaveDir] Could not clear remembered save folder:", error);
		}
	}

	// ---------------------------------------------------------------------
	// Minimal overlay UI. Shown only when we need the player to either pick
	// a folder for the first time, or click once to re-grant permission to
	// the folder they already picked in an earlier session.
	// ---------------------------------------------------------------------

	let stylesInjected = false;
	function injectStyles()
	{
		if(stylesInjected)
			return;
		stylesInjected = true;

		const style = document.createElement("style");
		style.textContent = `
			.es-savedir-overlay {
				position: fixed;
				inset: 0;
				z-index: 99999;
				display: flex;
				align-items: center;
				justify-content: center;
				background: rgba(8, 10, 14, 0.92);
				font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				color: #e6e6e6;
			}
			.es-savedir-box {
				max-width: 440px;
				margin: 16px;
				padding: 28px 32px;
				background: #161a22;
				border: 1px solid #2c3340;
				border-radius: 10px;
				box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
				text-align: center;
			}
			.es-savedir-box h1 {
				font-size: 17px;
				font-weight: 600;
				margin: 0 0 10px;
				color: #f2f2f2;
			}
			.es-savedir-box p {
				font-size: 13.5px;
				line-height: 1.5;
				color: #aab0bd;
				margin: 0 0 20px;
			}
			.es-savedir-box button {
				font-size: 14px;
				font-weight: 600;
				padding: 10px 22px;
				border-radius: 6px;
				border: none;
				background: #3b7ddd;
				color: #fff;
				cursor: pointer;
			}
			.es-savedir-box button:hover {
				background: #4c8ae6;
			}
			.es-savedir-box button:disabled {
				background: #2c3340;
				color: #777;
				cursor: default;
			}
			.es-savedir-error {
				margin-top: 14px;
				font-size: 12.5px;
				color: #e38b8b;
			}
		`;
		document.head.appendChild(style);
	}

	// Resolves to a handle object once the button is first clicked:
	// {done, fail, retry}. "retry" re-arms the same button/overlay and
	// returns a promise for the next click, so the same overlay can be
	// reused across several failed attempts without flicker.
	function showPrompt(title, message, buttonLabel)
	{
		injectStyles();

		const overlay = document.createElement("div");
		overlay.className = "es-savedir-overlay";

		const box = document.createElement("div");
		box.className = "es-savedir-box";

		const heading = document.createElement("h1");
		heading.textContent = title;

		const text = document.createElement("p");
		text.textContent = message;

		const button = document.createElement("button");
		button.textContent = buttonLabel;

		const errorLine = document.createElement("div");
		errorLine.className = "es-savedir-error";
		errorLine.style.display = "none";

		box.appendChild(heading);
		box.appendChild(text);
		box.appendChild(button);
		box.appendChild(errorLine);
		overlay.appendChild(box);
		document.body.appendChild(overlay);

		function waitForClick()
		{
			return new Promise(function(resolveClick)
			{
				button.addEventListener("click", function onClick()
				{
					button.removeEventListener("click", onClick);
					button.disabled = true;
					errorLine.style.display = "none";
					resolveClick({
						done: function() { overlay.remove(); },
						fail: function(message)
						{
							button.disabled = false;
							errorLine.textContent = message;
							errorLine.style.display = "block";
						},
						retry: waitForClick
					});
				}, {once: true});
			});
		}

		return waitForClick();
	}

	// Repeatedly prompts until the given attempt function succeeds (it
	// resolves to a truthy result) or the player has no way to retry
	// (attempt throws something unrecoverable). Each click is a fresh user
	// gesture, which the File System Access API requires.
	async function promptUntilSuccess(title, message, buttonLabel, attempt)
	{
		let prompt = await showPrompt(title, message, buttonLabel);
		for(;;)
		{
			try
			{
				const result = await attempt();
				prompt.done();
				return result;
			}
			catch(error)
			{
				console.error("[SaveDir]", error);
				// Show the error on the same overlay and wait for another
				// click (a fresh user gesture) before retrying.
				prompt.fail(describeError(error));
				prompt = await prompt.retry();
			}
		}
	}

	function describeError(error)
	{
		if(error && error.name === "AbortError")
			return "No folder was selected. Click the button to try again.";
		if(error && error.name === "NotAllowedError")
			return "Permission was not granted. Click the button to try again.";
		return "Something went wrong (" + (error && error.message ? error.message : error) + "). Click to try again.";
	}

	// ---------------------------------------------------------------------
	// Acquiring a usable, permitted directory handle.
	// ---------------------------------------------------------------------

	async function verifyPermission(handle, requestIfNeeded)
	{
		const options = {mode: "readwrite"};
		if((await handle.queryPermission(options)) === "granted")
			return true;
		if(!requestIfNeeded)
			return false;
		return (await handle.requestPermission(options)) === "granted";
	}

	async function pickNewDirectory()
	{
		const handle = await window.showDirectoryPicker({
			id: "endless-sky-save-folder",
			mode: "readwrite",
			startIn: "documents"
		});
		if(!(await verifyPermission(handle, true)))
			throw new Error("Read/write permission was not granted for that folder.");
		await storeHandle(handle);
		return handle;
	}

	async function acquireDirectoryHandle()
	{
		if(!("showDirectoryPicker" in window))
		{
			// File System Access API isn't available (e.g. Firefox, Safari).
			// Fall back to an in-memory-only MEMFS with no persistence at
			// all, rather than failing to start. The player is told plainly
			// rather than silently losing saves.
			await showPrompt(
				"Save folder not supported here",
				"This browser doesn't support choosing a real save folder. " +
				"Your progress will only last for this browser tab and won't be saved. " +
				"For persistent saves, use a Chromium-based browser (e.g. Chrome, Edge).",
				"Continue anyway"
			).then(function(prompt) { prompt.done(); });
			return null;
		}

		const stored = await loadStoredHandle();
		if(stored)
		{
			try
			{
				if(await verifyPermission(stored, false))
					return stored;

				// We have a remembered folder, but need a fresh user gesture
				// to re-confirm permission for it.
				return await promptUntilSuccess(
					"Resume your saves",
					"Click below to reuse your previously chosen save folder.",
					"Use remembered folder",
					async function()
					{
						if(!(await verifyPermission(stored, true)))
							throw new Error("Permission was not granted.");
						return stored;
					}
				);
			}
			catch(error)
			{
				// The remembered handle is no longer usable (folder moved,
				// deleted, permission permanently revoked, etc). Fall
				// through to asking for a new one.
				console.error("[SaveDir] Remembered save folder is no longer usable:", error);
				await clearStoredHandle();
			}
		}

		return await promptUntilSuccess(
			"Choose a save folder",
			"Pick a folder on your computer where Endless Sky will keep your saves, " +
			"pilots, and settings. You can reuse an existing folder or create a new one. " +
			"Because this is a real folder rather than browser storage, your saves are " +
			"unaffected if this site's data ever needs to be reset.",
			"Choose folder",
			pickNewDirectory
		);
	}

	// ---------------------------------------------------------------------
	// Recursive copy helpers between a FileSystemDirectoryHandle (the real
	// folder) and Emscripten's FS (MEMFS, mounted at MOUNT_PATH).
	// ---------------------------------------------------------------------

	async function copyRealDirToMemfs(realDir, memfsPath)
	{
		for await (const [name, handle] of realDir.entries())
		{
			const childPath = memfsPath + "/" + name;
			if(handle.kind === "directory")
			{
				try { FS.mkdir(childPath); }
				catch(error)
				{
					if(!(error && error.name === "ErrnoError" && error.errno === 20 /* EEXIST */))
						throw error;
				}
				await copyRealDirToMemfs(handle, childPath);
			}
			else
			{
				const file = await handle.getFile();
				const buffer = new Uint8Array(await file.arrayBuffer());
				FS.writeFile(childPath, buffer);
			}
		}
	}

	// Mirrors MEMFS at memfsPath onto the real directory, deleting real
	// files/folders that no longer exist in MEMFS so deletions (e.g. a
	// deleted save) propagate too.
	async function copyMemfsToRealDir(memfsPath, realDir)
	{
		const memfsEntries = new Map();
		for(const name of FS.readdir(memfsPath))
		{
			if(name === "." || name === "..")
				continue;
			memfsEntries.set(name, FS.stat(memfsPath + "/" + name));
		}

		// Remove anything on disk that's no longer in MEMFS.
		for await (const [name] of realDir.entries())
		{
			if(!memfsEntries.has(name))
				await realDir.removeEntry(name, {recursive: true});
		}

		for(const [name, stat] of memfsEntries)
		{
			const childPath = memfsPath + "/" + name;
			if(FS.isDir(stat.mode))
			{
				const childRealDir = await realDir.getDirectoryHandle(name, {create: true});
				await copyMemfsToRealDir(childPath, childRealDir);
			}
			else
			{
				const data = FS.readFile(childPath); // Uint8Array
				const fileHandle = await realDir.getFileHandle(name, {create: true});
				const writable = await fileHandle.createWritable();
				await writable.write(data);
				await writable.close();
			}
		}
	}

	// ---------------------------------------------------------------------
	// Wiring into the Emscripten module lifecycle.
	// ---------------------------------------------------------------------

	Module["preRun"] = Module["preRun"] || [];
	Module["preRun"].push(function()
	{
		try { FS.mkdir(MOUNT_PATH); }
		catch(error)
		{
			if(!(error && error.name === "ErrnoError" && error.errno === 20 /* EEXIST */))
				console.error("[SaveDir] Could not create " + MOUNT_PATH + ":", error);
		}
		FS.mount(MEMFS, {}, MOUNT_PATH);

		Module.addRunDependency("savedir-initial-sync");
		(async function()
		{
			let realDir = null;
			try
			{
				realDir = await acquireDirectoryHandle();
			}
			catch(error)
			{
				console.error("[SaveDir] Giving up on choosing a save folder; progress will not persist:", error);
			}

			if(realDir)
			{
				try
				{
					await copyRealDirToMemfs(realDir, MOUNT_PATH);
				}
				catch(error)
				{
					console.error("[SaveDir] Initial load from save folder failed:", error);
				}
				installAutoSync(realDir);
			}

			Module.removeRunDependency("savedir-initial-sync");
		})();
	});

	function installAutoSync(realDir)
	{
		let syncTimer = null;
		let syncInFlight = null;
		let syncAgainAfter = false;

		async function runSync()
		{
			try
			{
				await copyMemfsToRealDir(MOUNT_PATH, realDir);
			}
			catch(error)
			{
				console.error("[SaveDir] Failed to sync saves to disk:", error);
			}
		}

		function requestSync()
		{
			if(syncInFlight)
			{
				syncAgainAfter = true;
				return;
			}
			syncInFlight = runSync().then(function()
			{
				syncInFlight = null;
				if(syncAgainAfter)
				{
					syncAgainAfter = false;
					requestSync();
				}
			});
		}

		function scheduleSync()
		{
			if(syncTimer !== null)
				clearTimeout(syncTimer);
			syncTimer = setTimeout(function()
			{
				syncTimer = null;
				requestSync();
			}, SYNC_DEBOUNCE_MS);
		}

		function flushNow()
		{
			if(syncTimer !== null)
			{
				clearTimeout(syncTimer);
				syncTimer = null;
			}
			requestSync();
		}

		// MEMFS has no built-in change notification, so we hook FS.trackingDelegate,
		// which Emscripten's FS layer invokes on writes/creates/deletes/moves
		// regardless of which backend is mounted.
		FS.trackingDelegate = FS.trackingDelegate || {};
		const previous = {
			onWriteToFile: FS.trackingDelegate.onWriteToFile,
			onMakeDirectory: FS.trackingDelegate.onMakeDirectory,
			onDeletePath: FS.trackingDelegate.onDeletePath,
			onMovePath: FS.trackingDelegate.onMovePath
		};
		function withinMount(path) { return typeof path === "string" && path.indexOf(MOUNT_PATH) === 0; }

		FS.trackingDelegate.onWriteToFile = function(path)
		{
			if(previous.onWriteToFile) previous.onWriteToFile.apply(this, arguments);
			if(withinMount(path)) scheduleSync();
		};
		FS.trackingDelegate.onMakeDirectory = function(path)
		{
			if(previous.onMakeDirectory) previous.onMakeDirectory.apply(this, arguments);
			if(withinMount(path)) scheduleSync();
		};
		FS.trackingDelegate.onDeletePath = function(path)
		{
			if(previous.onDeletePath) previous.onDeletePath.apply(this, arguments);
			if(withinMount(path)) scheduleSync();
		};
		FS.trackingDelegate.onMovePath = function(oldPath, newPath)
		{
			if(previous.onMovePath) previous.onMovePath.apply(this, arguments);
			if(withinMount(oldPath) || withinMount(newPath)) scheduleSync();
		};

		// Belt-and-braces: also flush on tab hide and on unload, so a
		// debounce window doesn't lose a save made right before the player
		// closes the tab.
		document.addEventListener("visibilitychange", function()
		{
			if(document.visibilityState === "hidden")
				flushNow();
		});
		window.addEventListener("pagehide", flushNow);
		window.addEventListener("beforeunload", flushNow);
	}

	// Exposed for the C++ side (or dev tools) to let the player deliberately
	// switch to a different save folder without reloading the page, and to
	// forget the current one. Not required for normal operation.
	Module["chooseNewSaveFolder"] = async function()
	{
		const handle = await pickNewDirectory();
		await copyRealDirToMemfs(handle, MOUNT_PATH);
		installAutoSync(handle);
		return handle;
	};
	Module["forgetSaveFolder"] = clearStoredHandle;
})();
