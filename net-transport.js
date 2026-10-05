// net-transport.js
//
// Browser-main-thread WebRTC bridge for Endless Sky multiplayer.
//
// Signaling is fully serverless: the host and guest manually exchange compact,
// compressed connection codes. The signaling UI lives in the browser DOM rather
// than in Endless Sky's C++ panel stack, so asynchronous code generation never
// pauses the game simulation.

const ES_NET_STATE_DISCONNECTED = 0;
const ES_NET_STATE_SIGNALING = 1;
const ES_NET_STATE_CONNECTED = 2;
const ES_NET_STATE_FAILED = 3;

(function()
{
	let peerConnection = null;
	let dataChannel = null;
	let isHost = false;

	const RTC_CONFIG = {
		iceServers: [],
	};

	const CODE_VERSION = 2;
	const TYPE_OFFER = 0;
	const TYPE_ANSWER = 1;
	const COMPRESSION_GZIP = 1;
	const COMPRESSION_RAW = 0;

	function allocateUTF8Manual(text)
	{
		const encoded = new TextEncoder().encode(text);
		const ptr = Module._esNetTransportAlloc(encoded.length + 1);
		if(!ptr)
			throw new Error("esNetTransportAlloc failed");
		Module.HEAPU8.set(encoded, ptr);
		Module.HEAPU8[ptr + encoded.length] = 0;
		return ptr;
	}

	function reportState(state, detail)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnStateChange)
			return;
		try
		{
			const detailPtr = allocateUTF8Manual(detail || "");
			Module._esNetTransportOnStateChange(state, detailPtr);
			Module._esNetTransportFree(detailPtr);
		}
		catch(error)
		{
			console.error("[Net] reportState failed:", error);
		}
	}

	function reportLocalDescription(text)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnLocalDescription)
			return;
		try
		{
			const textPtr = allocateUTF8Manual(text);
			Module._esNetTransportOnLocalDescription(textPtr);
			Module._esNetTransportFree(textPtr);
		}
		catch(error)
		{
			console.error("[Net] reportLocalDescription failed:", error);
		}
	}

	function reportMessage(bytes)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnMessage)
			return;
		try
		{
			const ptr = Module._esNetTransportAlloc(bytes.byteLength);
			if(!ptr)
				throw new Error("esNetTransportAlloc failed");
			Module.HEAPU8.set(new Uint8Array(bytes), ptr);
			Module._esNetTransportOnMessage(ptr, bytes.byteLength);
			Module._esNetTransportFree(ptr);
		}
		catch(error)
		{
			console.error("[Net] reportMessage failed:", error);
		}
	}

	function normalizeConnectionCode(code)
	{
		return String(code || "").replace(/\s+/g, "");
	}

	function base64UrlEncode(bytes)
	{
		let binary = "";
		const chunkSize = 0x8000;
		for(let offset = 0; offset < bytes.length; offset += chunkSize)
		{
			const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
			binary += String.fromCharCode(...chunk);
		}
		return btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
	}

	function base64UrlDecode(text)
	{
		const normalized = normalizeConnectionCode(text)
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		if(!normalized.length)
			throw new Error("The connection code is empty.");
		if(!/^[A-Za-z0-9+/]*$/.test(normalized))
			throw new Error("The connection code contains invalid characters.");

		const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
		let binary;
		try
		{
			binary = atob(padded);
		}
		catch(error)
		{
			throw new Error("The connection code is not valid base64 data.");
		}

		const bytes = new Uint8Array(binary.length);
		for(let i = 0; i < binary.length; ++i)
			bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	async function compressBytes(bytes)
	{
		if(typeof CompressionStream === "undefined")
			return {method: COMPRESSION_RAW, bytes};

		const compressor = new CompressionStream("gzip");
		// IMPORTANT: start reading compressor.readable BEFORE/CONCURRENTLY
		// with writing, not after awaiting write()+close(). A
		// CompressionStream is a TransformStream with a bounded internal
		// queue (backpressure): write()'s returned promise does not resolve
		// until there's room in that queue, and room is only freed up by
		// something consuming the readable side. The previous code awaited
		// writer.write() and writer.close() to finish BEFORE starting
		// new Response(compressor.readable).arrayBuffer() - i.e. nothing was
		// draining the readable side while the write/close were pending. For
		// small inputs that fit entirely within the default high-water mark
		// this can happen to resolve, but it is not guaranteed, and once the
		// compressed output doesn't fit in one internal chunk the write (and
		// therefore close) promise never settles: a deadlock with no error
		// and no timeout, since nothing here was ever waiting with a timer.
		// Kicking off the read here lets the two sides run concurrently, as
		// a TransformStream's write/read pair is meant to be used.
		const readPromise = new Response(compressor.readable).arrayBuffer();
		const writer = compressor.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return {
			method: COMPRESSION_GZIP,
			bytes: new Uint8Array(await readPromise),
		};
	}

	async function decompressBytes(bytes, method)
	{
		if(method === COMPRESSION_RAW)
			return bytes;
		if(method !== COMPRESSION_GZIP)
			throw new Error("The connection code uses an unsupported compression format.");
		if(typeof DecompressionStream === "undefined")
			throw new Error("This browser cannot decompress this connection code.");

		const decompressor = new DecompressionStream("gzip");
		// Same concurrent read-while-writing fix as compressBytes() above -
		// start draining decompressor.readable before awaiting write()/close()
		// so the stream can't deadlock on backpressure.
		const readPromise = new Response(decompressor.readable).arrayBuffer();
		const writer = decompressor.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await readPromise);
	}

	async function encodeConnectionCode(description)
	{
		if(!description || typeof description.sdp !== "string" || !description.sdp.length)
			throw new Error("WebRTC did not produce a usable connection description.");

		const typeByte = description.type === "offer" ? TYPE_OFFER :
			description.type === "answer" ? TYPE_ANSWER : -1;
		if(typeByte < 0)
			throw new Error("WebRTC produced an unsupported description type.");

		const sdpBytes = new TextEncoder().encode(description.sdp);
		const compressed = await compressBytes(sdpBytes);
		// The envelope contains format version, description type, compression
		// method, then the compressed SDP bytes.
		const finalPayload = new Uint8Array(3 + compressed.bytes.length);
		finalPayload[0] = CODE_VERSION;
		finalPayload[1] = typeByte;
		finalPayload[2] = compressed.method;
		finalPayload.set(compressed.bytes, 3);
		return base64UrlEncode(finalPayload);
	}

	async function decodeConnectionCode(codeText)
	{
		const encoded = base64UrlDecode(codeText);
		if(encoded.length < 4)
			throw new Error("The connection code is too short.");
		if(encoded[0] !== CODE_VERSION)
			throw new Error("The connection code uses an unsupported version.");

		let type;
		if(encoded[1] === TYPE_OFFER)
			type = "offer";
		else if(encoded[1] === TYPE_ANSWER)
			type = "answer";
		else
			throw new Error("The connection code contains an invalid description type.");

		const payload = await decompressBytes(encoded.subarray(3), encoded[2]);
		const sdp = new TextDecoder().decode(payload);
		if(!sdp.startsWith("v=0\r\n") && !sdp.startsWith("v=0\n"))
			throw new Error("The connection code does not contain valid SDP.");
		return {type, sdp};
	}

	function selectAndCopy(element)
	{
		element.focus();
		element.select();
		try { document.execCommand("copy"); }
		catch(error) {}
	}

	async function copyText(text, element, statusElement)
	{
		try
		{
			if(navigator.clipboard && window.isSecureContext)
				await navigator.clipboard.writeText(text);
			else
				selectAndCopy(element);
			statusElement.textContent = "Copied.";
		}
		catch(error)
		{
			selectAndCopy(element);
			statusElement.textContent = "Selected. Press Ctrl+C to copy.";
		}
	}

	let overlay = null;
	let overlayTitle = null;
	let overlayStatus = null;
	let overlayBody = null;

	function closeMultiplayerUI()
	{
		if(overlay)
			overlay.remove();
		overlay = null;
		overlayTitle = null;
		overlayStatus = null;
		overlayBody = null;
	}

	function buildOverlay(title)
	{
		closeMultiplayerUI();

		let style = document.getElementById("es-mp-style");
		if(!style)
		{
			style = document.createElement("style");
			style.id = "es-mp-style";
			style.textContent = `
			#es-mp-overlay { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.82); font-family:sans-serif; color:white; }
			#es-mp-card { width:min(900px,92vw); max-height:88vh; box-sizing:border-box; padding:24px; border:1px solid rgba(255,255,255,.25); border-radius:10px; background:#111; box-shadow:0 12px 40px rgba(0,0,0,.6); }
			#es-mp-card h2 { margin:0 0 12px; font-size:24px; }
			#es-mp-status { margin:0 0 14px; opacity:.8; white-space:pre-wrap; }
			#es-mp-body { display:flex; flex-direction:column; gap:12px; }
			#es-mp-code, #es-mp-input { width:100%; min-height:120px; box-sizing:border-box; padding:12px; border-radius:6px; border:1px solid #555; background:#050505; color:#fff; font:14px/1.45 monospace; resize:vertical; }
			#es-mp-code { min-height:180px; }
			#es-mp-actions { display:flex; gap:10px; flex-wrap:wrap; }
			#es-mp-actions button { padding:9px 16px; border:1px solid #666; border-radius:6px; background:#222; color:#fff; cursor:pointer; }
			#es-mp-actions button:hover { background:#333; }
		`;
			document.head.appendChild(style);
		}

		overlay = document.createElement("div");
		overlay.id = "es-mp-overlay";
		const card = document.createElement("div");
		card.id = "es-mp-card";
		overlayTitle = document.createElement("h2");
		overlayTitle.textContent = title;
		overlayStatus = document.createElement("div");
		overlayStatus.id = "es-mp-status";
		overlayBody = document.createElement("div");
		overlayBody.id = "es-mp-body";
		card.append(overlayTitle, overlayStatus, overlayBody);
		overlay.appendChild(card);
		document.body.appendChild(overlay);
		return overlay;
	}

	function setOverlayStatus(text, error = false)
	{
		if(!overlayStatus)
			return;
		overlayStatus.textContent = text;
		overlayStatus.style.opacity = error ? "1" : ".8";
		overlayStatus.style.color = error ? "#ff8080" : "";
	}

	function setError(text)
	{
		setOverlayStatus(text, true);
		if(!overlayBody)
			return;
		const actions = document.createElement("div");
		actions.id = "es-mp-actions";
		const close = document.createElement("button");
		close.textContent = "Close";
		close.onclick = closeMultiplayerUI;
		actions.appendChild(close);
		overlayBody.appendChild(actions);
	}

	function showCode(title, status, code, nextLabel, onNext)
	{
		buildOverlay(title);
		setOverlayStatus(status);

		const codeBox = document.createElement("textarea");
		codeBox.id = "es-mp-code";
		codeBox.readOnly = true;
		codeBox.value = code;
		codeBox.addEventListener("click", function() { codeBox.select(); });

		const actions = document.createElement("div");
		actions.id = "es-mp-actions";
		const copy = document.createElement("button");
		copy.textContent = "Copy Code";
		copy.onclick = function() { copyText(code, codeBox, overlayStatus); };
		actions.appendChild(copy);

		if(nextLabel && onNext)
		{
			const next = document.createElement("button");
			next.textContent = nextLabel;
			next.onclick = onNext;
			actions.appendChild(next);
		}

		const close = document.createElement("button");
		close.textContent = "Close";
		close.onclick = function()
		{
			closePeerConnection();
			closeMultiplayerUI();
		};
		actions.appendChild(close);

		overlayBody.append(codeBox, actions);
		codeBox.focus();
		codeBox.select();
	}

	function showHostCode(code)
	{
		showCode("Host a Multiplayer Game",
			"Send this connection code to the other player. They can paste it directly into their browser.",
			code,
			"Enter Reply Code",
			showHostReplyInput);
	}

	function showHostReplyInput()
	{
		buildOverlay("Host a Multiplayer Game");
		setOverlayStatus("Paste the guest's reply code below, then connect.");

		const input = document.createElement("textarea");
		input.id = "es-mp-input";
		input.placeholder = "Paste the reply code here...";
		const actions = document.createElement("div");
		actions.id = "es-mp-actions";
		const connect = document.createElement("button");
		connect.textContent = "Connect";
		connect.onclick = async function()
		{
			const text = input.value.trim();
			if(!text)
			{
				setOverlayStatus("Paste the reply code first.", true);
				return;
			}
			connect.disabled = true;
			setOverlayStatus("Connecting...");
			await self.__esNetTransport.acceptRemoteDescription(text);
		};
		const close = document.createElement("button");
		close.textContent = "Close";
		close.onclick = function() { closePeerConnection(); closeMultiplayerUI(); };
		actions.append(connect, close);
		overlayBody.append(input, actions);
		input.focus();
	}

	function showGuestUI()
	{
		buildOverlay("Join a Multiplayer Game");
		setOverlayStatus("Paste the host's connection code below.");

		const input = document.createElement("textarea");
		input.id = "es-mp-input";
		input.placeholder = "Paste the host code here...";
		const actions = document.createElement("div");
		actions.id = "es-mp-actions";
		const connect = document.createElement("button");
		connect.textContent = "Join Game";
		connect.onclick = async function()
		{
			const text = input.value.trim();
			if(!text)
			{
				setOverlayStatus("Paste the host code first.", true);
				return;
			}
			connect.disabled = true;
			input.disabled = true;
			setOverlayStatus("Creating your reply code...");
			await self.__esNetTransport.joinHost(text);
		};
		const close = document.createElement("button");
		close.textContent = "Close";
		close.onclick = function() { closePeerConnection(); closeMultiplayerUI(); };
		actions.append(connect, close);
		overlayBody.append(input, actions);
		input.focus();
	}

	function showHostUI()
	{
		buildOverlay("Host a Multiplayer Game");
		setOverlayStatus("Generating your connection code...");
	}

	async function publishLocalDescription(description)
	{
		try
		{
			const code = await encodeConnectionCode(description);
			reportLocalDescription(code);
			console.log("[Net] Generated " + description.type + " connection code (" + code.length + " characters).");
			if(description.type === "offer")
				showHostCode(code);
			else
				showCode("Reply to Multiplayer Host",
					"Send this reply code back to the host.",
					code,
					"Close",
					closeMultiplayerUI);
		}
		catch(error)
		{
			setOverlayError("Could not generate the connection code: " + error.message);
			reportState(ES_NET_STATE_FAILED, "Could not generate the connection code: " + error.message);
			console.error("[Net] Connection-code generation failed:", error);
		}
	}

	function setOverlayError(message)
	{
		if(!overlay)
		{
			buildOverlay("Multiplayer Error");
		}
		setError(message);
	}

	function waitForIceGatheringComplete(connection)
	{
		if(connection.iceGatheringState === "complete")
			return Promise.resolve();

		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				connection.removeEventListener("icegatheringstatechange", checkState);
				connection.removeEventListener("icecandidate", checkCandidate);
			};
			const finish = () => {
				if(settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const fail = error => {
				if(settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const checkState = () => {
				if(connection.iceGatheringState === "complete")
					finish();
			};
			const checkCandidate = event => {
				if(event.candidate === null)
					finish();
			};
			const timer = setTimeout(() => fail(new Error("ICE gathering timed out.")), 30000);
			connection.addEventListener("icegatheringstatechange", checkState);
			connection.addEventListener("icecandidate", checkCandidate);
			checkState();
		});
	}

	function closePeerConnection()
	{
		if(dataChannel)
		{
			try { dataChannel.close(); } catch(error) {}
			dataChannel = null;
		}
		if(peerConnection)
		{
			try { peerConnection.close(); } catch(error) {}
			peerConnection = null;
		}
	}

	function wireDataChannel(channel)
	{
		channel.binaryType = "arraybuffer";
		channel.onopen = function()
		{
			reportState(ES_NET_STATE_CONNECTED, "");
			closeMultiplayerUI();
		};
		channel.onclose = function()
		{
			reportState(ES_NET_STATE_DISCONNECTED, "data channel closed");
		};
		channel.onerror = function(event)
		{
			const message = "WebRTC data channel error: " + (event && event.message ? event.message : "unknown");
			setOverlayError(message);
			reportState(ES_NET_STATE_FAILED, message);
		};
		channel.onmessage = function(event)
		{
			if(event.data instanceof ArrayBuffer)
				reportMessage(event.data);
			else
				console.warn("[Net] Ignoring non-binary data channel message.");
		};
	}

	function wirePeerConnection(connection)
	{
		connection.onconnectionstatechange = function()
		{
			if(connection.connectionState === "failed")
			{
				const message = "WebRTC connection failed. A direct connection may not be possible between these networks without a STUN/TURN service.";
				setOverlayError(message);
				reportState(ES_NET_STATE_FAILED, message);
			}
			else if(connection.connectionState === "closed")
				reportState(ES_NET_STATE_DISCONNECTED, "WebRTC connection closed");
		};
	}

	self.__esNetTransport = {
		showHostUI,
		showGuestUI,
		startHosting: async function()
		{
			isHost = true;
			closePeerConnection();
			// Build the "Generating..." placeholder here, synchronously, as
			// part of the same call that will go on to build the real code.
			// Previously MultiplayerPanel.cpp dispatched showHostUI() and
			// startHosting() as two SEPARATE async main-thread calls. Both are
			// proxied independently via emscripten_async_run_in_main_runtime_thread,
			// which gives no ordering guarantee between two distinct proxied
			// calls relative to each other - only that each one's own body
			// runs to completion once started. If startHosting()'s awaits
			// (createOffer/setLocalDescription/ICE gathering) resolved fast
			// enough, it could finish and call showHostCode() BEFORE the
			// separately-queued showHostUI() call ran; showHostUI() would
			// then call buildOverlay(), which tears down and replaces
			// whatever overlay is currently showing - wiping out the real
			// code and leaving the empty placeholder on screen permanently,
			// since startHosting() has already finished and will never call
			// showHostCode() again. Calling showHostUI() here guarantees the
			// placeholder is always built before the code-generating work
			// starts, in the same synchronous call, with no race possible.
			showHostUI();
			reportState(ES_NET_STATE_SIGNALING, "");
			try
			{
				peerConnection = new RTCPeerConnection(RTC_CONFIG);
				wirePeerConnection(peerConnection);
				dataChannel = peerConnection.createDataChannel("endless-sky-net", {ordered: true});
				wireDataChannel(dataChannel);
				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				await waitForIceGatheringComplete(peerConnection);
				await publishLocalDescription(peerConnection.localDescription);
			}
			catch(error)
			{
				setOverlayError("Could not create a multiplayer connection code: " + error.message);
				reportState(ES_NET_STATE_FAILED, "Could not create a multiplayer connection code: " + error.message);
				console.error("[Net] Host setup failed:", error);
			}
		},

		joinHost: async function(codeText)
		{
			isHost = false;
			closePeerConnection();
			reportState(ES_NET_STATE_SIGNALING, "");
			try
			{
				// Guard against the same clobbering race as startHosting():
				// if an overlay isn't already up (e.g. this is being invoked
				// as the very first step of the join flow rather than from
				// the paste-code button inside an existing guest overlay),
				// make sure one exists before we start awaiting, so a
				// fast-resolving decode/connect can't finish before some
				// separately-dispatched UI call gets around to building it.
				if(!overlay)
					showGuestUI();
				const offer = await decodeConnectionCode(codeText);
				if(offer.type !== "offer")
					throw new Error("This is not a host connection code.");
				peerConnection = new RTCPeerConnection(RTC_CONFIG);
				wirePeerConnection(peerConnection);
				peerConnection.ondatachannel = function(event)
				{
					dataChannel = event.channel;
					wireDataChannel(dataChannel);
				};
				await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
				const answer = await peerConnection.createAnswer();
				await peerConnection.setLocalDescription(answer);
				await waitForIceGatheringComplete(peerConnection);
				await publishLocalDescription(peerConnection.localDescription);
			}
			catch(error)
			{
				setOverlayError("Failed to use the host connection code: " + error.message);
				reportState(ES_NET_STATE_FAILED, "Failed to use the host connection code: " + error.message);
				console.error("[Net] Guest setup failed:", error);
			}
		},

		acceptRemoteDescription: async function(codeText)
		{
			if(!peerConnection)
			{
				setOverlayError("No host connection is waiting for a reply code.");
				return;
			}
			try
			{
				const answer = await decodeConnectionCode(codeText);
				if(answer.type !== "answer")
					throw new Error("This is not a guest reply code.");
				await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
				setOverlayStatus("Answer accepted. Waiting for the direct connection...");
			}
			catch(error)
			{
				setOverlayError("Could not accept the guest connection code: " + error.message);
				reportState(ES_NET_STATE_FAILED, "Could not accept the guest connection code: " + error.message);
				console.error("[Net] Remote connection-code decode failed:", error);
			}
		},

		send: function(bytes)
		{
			if(!dataChannel || dataChannel.readyState !== "open")
				return;
			// This is invoked synchronously from the C++ side via
			// emscripten_sync_run_in_main_runtime_thread (see NetTransport::Send's
			// comment), which BLOCKS the calling thread until this function
			// returns. RTCDataChannel.send() throws a synchronous DOMException
			// ("InvalidStateError"/"OperationError") when its outgoing buffer is
			// saturated - e.g. right after the tab was backgrounded for a while
			// and a burst of queued state needs to flush at once, or any time
			// the peer can't drain data as fast as it's being produced. Letting
			// that exception escape this EM_JS-invoked function is unsafe: it
			// propagates up through the Emscripten runtime's internal call
			// machinery with nothing on the C++ side able to catch or recover
			// from it, and can leave that call (and anything after it in the
			// same synchronous proxy call) in a broken state with no retry -
			// which is consistent with sends simply never working again after
			// a backgrounded-tab stall, rather than a clean, resumable error.
			// Swallow it here instead: drop this one message (the data channel
			// is ordered+reliable for messages that DO get sent, but an app
			// level send() failure like this was never going to be retried
			// automatically either way) and let the next tick's send attempt
			// normally, once bufferedAmount has drained.
			try
			{
				dataChannel.send(bytes);
			}
			catch(error)
			{
				console.warn("[Net] Dropped outgoing message; data channel send buffer is saturated:", error);
			}
		},
	};
})();