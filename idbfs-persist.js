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
// Without this file, that directory lives only in Emscripten's in-memory
// filesystem (MEMFS): writes succeed during a session, but nothing survives
// a page reload or browser restart. This file mounts IDBFS (IndexedDB-backed)
// over "/libsdl" with autoPersist so every write is flushed to IndexedDB
// automatically -- no manual syncfs() calls needed anywhere in the C++ code --
// and it blocks main() from starting until the initial load from IndexedDB
// into MEMFS finishes, using the standard Emscripten runDependency mechanism.
// (Without that wait, Files::Init()/Preferences::Load() would run against an
// empty directory even when real save data exists in IndexedDB, because the
// initial IndexedDB read is asynchronous and cannot complete within main()
// itself -- see the Emscripten Filesystem API docs and SDL's own writeup of
// this exact race for -sPROXY_TO_PTHREAD/IDBFS builds.)
Module["preRun"] = Module["preRun"] || [];
Module["preRun"].push(function()
{
	const persistPath = "/libsdl";

	// mkdir throws if the directory already exists (e.g. on a hot reload in
	// development); that's fine, IDBFS just needs the directory to be there.
	try
	{
		FS.mkdir(persistPath);
	}
	catch(error)
	{
		if(!(error && error.name === "ErrnoError" && error.errno === 20 /* EEXIST */))
			console.error("[IDBFS] Could not create " + persistPath + ":", error);
	}

	// autoPersist means every write under this mount is flushed to IndexedDB
	// as it happens, so nothing else in this file (or in the C++ code) needs
	// to call FS.syncfs() again after the initial load below.
	FS.mount(IDBFS, {autoPersist: true}, persistPath);

	// Block main() from running until whatever was previously saved in
	// IndexedDB has been copied into MEMFS. addRunDependency/removeRunDependency
	// is the same mechanism Emscripten's own pthread pool warmup uses for
	// exactly this purpose: main() will not be invoked while any named
	// dependency is outstanding.
	Module.addRunDependency("idbfs-initial-sync");
	FS.syncfs(/* populate = */ true, function(error)
	{
		if(error)
			console.error("[IDBFS] Initial sync from IndexedDB failed:", error);
		Module.removeRunDependency("idbfs-initial-sync");
	});
});